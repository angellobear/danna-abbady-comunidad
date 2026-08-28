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
import { sendSubscriptionConfirmation, from as emailFrom } from '@/lib/email';

const serr = (e: unknown) => (e instanceof Error ? e.message : JSON.stringify(e));

export async function GET() {
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  // ponytail: un solo prefijo `[wh <rid>]` para filtrar toda la traza en Vercel
  const rid = Math.random().toString(36).slice(2, 8);
  const t0 = Date.now();
  const log = (step: string, extra?: Record<string, unknown>) =>
    console.log(`[wh ${rid}] ${step}`, { ms: Date.now() - t0, ...extra });

  // ── 1. HMAC verify ────────────────────────────────────────────────
  const rawBody = await req.text();
  log('IN', { bytes: rawBody.length, topic: req.headers.get('x-shopify-topic') });
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const providedHmac = req.headers.get('x-shopify-hmac-sha256');
  if (!secret) { log('ABORT no SHOPIFY_WEBHOOK_SECRET'); return NextResponse.json({ ok: false }, { status: 500 }); }
  if (!providedHmac) { log('ABORT no hmac header'); return NextResponse.json({ ok: false }, { status: 401 }); }

  const computed = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  try {
    const a = Buffer.from(providedHmac, 'utf8');
    const b = Buffer.from(computed, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      log('ABORT invalid hmac');
      return NextResponse.json({ ok: false, error: 'Invalid HMAC' }, { status: 401 });
    }
  } catch {
    log('ABORT hmac compare threw');
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  log('1/10 hmac ok');

  // ── 2. Parse + validate ───────────────────────────────────────────
  let raw: unknown;
  try { raw = JSON.parse(rawBody); } catch {
    log('ABORT invalid json');
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const parsed = shopifySubscriptionSchema.safeParse(raw);
  if (!parsed.success) {
    log('ABORT zod', { issues: parsed.error.issues.slice(0, 3) });
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const order = parsed.data;
  const orderId = String(order.id);

  // Audit trail. Awaited: sin await la funcion se congela al return y el
  // insert se pierde de forma aleatoria. Cuesta ~200ms y nunca tumba el
  // webhook: un fallo aqui solo se loguea.
  try {
    await logWebhookPayload(orderId, raw);
  } catch (err) {
    log('payload log FAILED', { error: serr(err) });
  }

  // ── 3. Filtro por product_id ──────────────────────────────────────
  const requiredProductId = process.env.SHOPIFY_SUBSCRIPTION_PRODUCT_ID;
  log('2/10 parsed', { orderId });
  if (requiredProductId && !order.line_items.some((li) => String(li.product_id) === requiredProductId)) {
    log('SKIP product_mismatch', { requiredProductId, got: order.line_items.map((li) => li.product_id) });
    return NextResponse.json({ ok: true, skipped: 'product_mismatch' });
  }
  log('3/10 product ok');

  // ── 4. Dedup ──────────────────────────────────────────────────────
  if (await isDuplicateAttempt(orderId)) {
    log('SKIP duplicate — ya procesado, no se reenvia email', { orderId });
    return NextResponse.json({ ok: true, duplicate: true });
  }
  log('4/10 not duplicate');

  // ── 5. Email + validar suscripción ───────────────────────────────
  const email = extractBuyerEmail(order);
  if (!email) {
    log('SKIP no_email');
    return NextResponse.json({ ok: true, skipped: 'no_email' });
  }
  const isSubscription = requiredProductId ? true : isSubscriptionOrder(order);
  if (!isSubscription) {
    log('SKIP not_subscription');
    return NextResponse.json({ ok: true, skipped: 'not_subscription' });
  }

  const name = extractBuyerName(order);
  const shopifyCustomerId = extractShopifyCustomerId(order);
  const shopifySellingPlanId = extractSellingPlanId(order);
  const paidAt = new Date();
  const periodEnd = new Date(paidAt.getTime() + membershipDurationMs());
  log('5/10 buyer ok', { email, name, shopifyCustomerId, periodEnd });

  // ── 6. Registrar intento ──────────────────────────────────────────
  await createAttempt(orderId);
  log('6/10 attempt created');

  const fail = async (error: string) => {
    log('FAIL 500 — Shopify reintentara', { reason: error });
    await markAttemptFailed(orderId, error);
    return NextResponse.json({ ok: false }, { status: 500 });
  };

  // ── 7. Circle: crear miembro ──────────────────────────────────────
  let circleMember: { id: number; created: boolean };
  try {
    circleMember = await findOrCreateMember(email, name ?? undefined);
    log('7/10 circle member ok', { circleMemberId: circleMember.id, created: circleMember.created });
  } catch (err) {
    log('circle member FAILED', { error: serr(err) });
    return fail('circle_member');
  }

  // ── 8. Circle: agregar al grupo de suscripción ───────────────────
  try {
    await addToSubscriptionGroup(email);
    log('8/10 subscription group ok');
  } catch (err) {
    log('circle group FAILED', { error: serr(err) });
    return fail('circle_group');
  }

  // ── 9. DB: upsert miembro + pago ─────────────────────────────────
  let expiresAt: Date;
  try {
    expiresAt = await upsertMemberPayment({
      email,
      name: name ?? null,
      circleId: circleMember.id,
      orderId,
      paidAt,
      periodEnd,
      shopifyCustomerId,
      shopifySellingPlanId,
    });
    log('9/10 db upsert ok', { expiresAt, periodEnd });
  } catch (err) {
    log('db upsert FAILED', { error: serr(err) });
    return fail('db_upsert');
  }

  await markAttemptCompleted(orderId);
  log('attempt completed');

  // ── 10. Email de renovación ──────────────────────────────────────
  // Solo a quienes ya existían en Circle: al miembro nuevo lo recibe el
  // onboarding de Circle, este correo dice "se renovó" y no aplica.
  if (circleMember.created) {
    log('10/10 email skipped — miembro nuevo, no es renovacion', { to: email });
  } else {
    try {
      log('10/10 sending email...', { to: email, from: emailFrom() });
      const id = await sendSubscriptionConfirmation(email, name ?? null, expiresAt);
      log('10/10 EMAIL SENT', { to: email, resendId: id });
    } catch (err) {
      log('10/10 EMAIL FAILED', { to: email, from: emailFrom(), error: serr(err) });
    }
  }

  // ponytail: awaited a proposito — en serverless la funcion se congela al
  // hacer return y las promesas sueltas nunca corren.
  if (shopifyCustomerId) {
    try {
      const contractId = await findSubscriptionContractId(shopifyCustomerId);
      if (contractId) await saveSubscriptionContractId(orderId, contractId);
      log('contract lookup', { contractId });
    } catch (err) {
      log('contract lookup FAILED', { error: serr(err) });
    }
  }

  if (process.env.CIRCLE_PREMIUM_GROUP_ID) {
    try {
      const streak = await getMemberStreak(email);
      const promote = streak >= premiumStreakThreshold();
      if (promote) await addToPremiumGroup(email);
      log('premium check', { streak, threshold: premiumStreakThreshold(), promote });
    } catch (err) {
      log('premium check FAILED', { error: serr(err) });
    }
  }

  log('DONE ok');
  return NextResponse.json({ ok: true, orderId });
}
