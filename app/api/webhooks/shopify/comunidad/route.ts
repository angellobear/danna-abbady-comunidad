import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { findOrCreateMember } from '@/lib/circle/members';
import { addToSubscriptionGroup, addToPremiumGroup } from '@/lib/circle/access-groups';
import {
  shopifySubscriptionSchema,
  extractBuyerEmail,
  extractBuyerName,
  extractShopifyCustomerId,
  extractSellingPlanId,
  isSubscriptionOrder,
} from '@/lib/schemas/shopify-subscription';
import { upsertMemberPayment, getMemberStreak, logWebhookPayload, saveSubscriptionContractId } from '@/lib/db/members';
import { findSubscriptionContractId } from '@/lib/shopify';
import { isDuplicateAttempt, createAttempt, markAttemptCompleted, markAttemptFailed } from '@/lib/db/webhook-attempts';
import { membershipDurationMs, premiumStreakThreshold } from '@/lib/config';
import { sendSubscriptionConfirmation } from '@/lib/email';

const serr = (e: unknown) => (e instanceof Error ? e.message : JSON.stringify(e));

export async function GET() {
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  // ── 1. HMAC verify ────────────────────────────────────────────────
  const rawBody = await req.text();
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const providedHmac = req.headers.get('x-shopify-hmac-sha256');
  if (!secret) return NextResponse.json({ ok: false }, { status: 500 });
  if (!providedHmac) return NextResponse.json({ ok: false }, { status: 401 });

  const computed = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  try {
    const a = Buffer.from(providedHmac, 'utf8');
    const b = Buffer.from(computed, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b))
      return NextResponse.json({ ok: false, error: 'Invalid HMAC' }, { status: 401 });
  } catch {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  // ── 2. Parse + validate ───────────────────────────────────────────
  let raw: unknown;
  try { raw = JSON.parse(rawBody); } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const parsed = shopifySubscriptionSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ ok: false }, { status: 400 });

  const order = parsed.data;
  const orderId = String(order.id);

  // Log raw payload (non-blocking — best-effort audit trail)
  logWebhookPayload(orderId, raw).catch(() => {});

  // ── 3. Filtro por product_id ──────────────────────────────────────
  const requiredProductId = process.env.SHOPIFY_SUBSCRIPTION_PRODUCT_ID;
  if (requiredProductId && !order.line_items.some((li) => String(li.product_id) === requiredProductId)) {
    return NextResponse.json({ ok: true, skipped: 'product_mismatch' });
  }

  // ── 4. Dedup ──────────────────────────────────────────────────────
  if (await isDuplicateAttempt(orderId)) {
    console.log('[webhook] duplicate attempt, skipping', { orderId });
    return NextResponse.json({ ok: true, duplicate: true });
  }

  // ── 5. Email + validar suscripción ───────────────────────────────
  const email = extractBuyerEmail(order);
  if (!email) {
    console.error({ event: 'shopify.no_email', orderId });
    return NextResponse.json({ ok: true, skipped: 'no_email' });
  }
  const isSubscription = requiredProductId ? true : isSubscriptionOrder(order);
  if (!isSubscription) {
    console.log('[webhook] skipped — not a subscription order', { orderId });
    return NextResponse.json({ ok: true, skipped: 'not_subscription' });
  }

  const name = extractBuyerName(order);
  const shopifyCustomerId = extractShopifyCustomerId(order);
  const shopifySellingPlanId = extractSellingPlanId(order);
  const paidAt = new Date();
  const periodEnd = new Date(paidAt.getTime() + membershipDurationMs());
  console.log('[webhook] processing order', { orderId, email, name, shopifyCustomerId, periodEnd });

  // ── 6. Registrar intento ──────────────────────────────────────────
  await createAttempt(orderId);

  const fail = async (error: string) => {
    await markAttemptFailed(orderId, error);
    return NextResponse.json({ ok: false }, { status: 500 });
  };

  // ── 7. Circle: crear miembro ──────────────────────────────────────
  let circleMember: { id: number; created: boolean };
  try {
    circleMember = await findOrCreateMember(email, name ?? undefined);
    console.log('[webhook] circle member ready', { orderId, circleMemberId: circleMember.id, created: circleMember.created });
  } catch (err) {
    console.error({ event: 'shopify.circle_member_failed', orderId, error: serr(err) });
    return fail('circle_member');
  }

  // ── 8. Circle: agregar al grupo de suscripción ───────────────────
  try {
    await addToSubscriptionGroup(email);
    console.log('[webhook] added to subscription group', { orderId });
  } catch (err) {
    console.error({ event: 'shopify.circle_group_failed', orderId, error: serr(err) });
    return fail('circle_group');
  }

  // ── 9. DB: upsert miembro + pago ─────────────────────────────────
  try {
    await upsertMemberPayment({
      email,
      name: name ?? null,
      circleId: circleMember.id,
      orderId,
      paidAt,
      periodEnd,
      shopifyCustomerId,
      shopifySellingPlanId,
    });
    console.log('[webhook] db upsert ok', { orderId });
  } catch (err) {
    console.error({ event: 'shopify.db_failed', orderId, error: serr(err) });
    return fail('db_upsert');
  }

  await markAttemptCompleted(orderId);
  console.log({ event: 'shopify.processed', orderId, email, circleMemberId: circleMember.id });

  // ── 10. Email de confirmación ────────────────────────────────────
  // ponytail: se envía siempre por ahora; para volver a mandarlo solo en
  // renovaciones, envolver en `if (!circleMember.created)`.
  try {
    await sendSubscriptionConfirmation(email, name ?? null, periodEnd);
    console.log('[webhook] email sent', { orderId, email, created: circleMember.created });
  } catch (err) {
    console.error({ event: 'shopify.email_failed', orderId, error: serr(err) });
  }

  if (shopifyCustomerId) {
    findSubscriptionContractId(shopifyCustomerId)
      .then((contractId) => {
        if (contractId) return saveSubscriptionContractId(orderId, contractId);
      })
      .catch((err) =>
        console.error({ event: 'shopify.contract_lookup_failed', orderId, error: serr(err) }),
      );
  }

  if (process.env.CIRCLE_PREMIUM_GROUP_ID) {
    getMemberStreak(email).then((streak) => {
      if (streak >= premiumStreakThreshold()) addToPremiumGroup(email).catch(console.error);
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true, orderId });
}
