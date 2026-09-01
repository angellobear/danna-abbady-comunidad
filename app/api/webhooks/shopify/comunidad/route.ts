import { NextRequest, NextResponse, after } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { findMemberByEmail, createMember } from '@/lib/circle/members';
import { addToSubscriptionGroup, addToPremiumGroup } from '@/lib/circle/access-groups';
import {
  shopifySubscriptionSchema,
  extractBuyerEmail,
  extractBuyerName,
  extractShopifyCustomerId,
  extractSellingPlanId,
  isSubscriptionOrder,
} from '@/lib/schemas/shopify-subscription';
import { upsertMemberPayment, getMemberStreak, logWebhook, saveSubscriptionContractId, memberExists, type WebhookStep } from '@/lib/db/members';
import { findSubscriptionContractId } from '@/lib/shopify';
import { isDuplicateAttempt, createAttempt, markAttemptCompleted, markAttemptFailed } from '@/lib/db/webhook-attempts';
import { membershipDurationMs, premiumStreakThreshold } from '@/lib/config';
import { sendSubscriptionConfirmation, from as emailFrom } from '@/lib/email';

const serr = (e: unknown) => (e instanceof Error ? e.message : JSON.stringify(e));

export async function GET() {
  return NextResponse.json({ ok: true });
}

type Log = (step: string, extra?: Record<string, unknown>) => void;
type Ctx = { orderId: string | null; matched: boolean; payload: unknown };

export async function POST(req: NextRequest) {
  // ponytail: un solo prefijo `[wh <rid>]` para filtrar toda la traza en Vercel
  const rid = Math.random().toString(36).slice(2, 8);
  const t0 = Date.now();
  const steps: WebhookStep[] = [];
  const ctx: Ctx = { orderId: null, matched: false, payload: null };
  const log: Log = (step, extra) => {
    console.log(`[wh ${rid}] ${step}`, { ms: Date.now() - t0, ...extra });
    steps.push({ ms: Date.now() - t0, step, data: extra ?? null });
  };

  try {
    return await handle(req, log, ctx);
  } finally {
    // after() corre DESPUES de enviar la respuesta y mantiene viva la funcion
    // serverless: los logs no suman latencia ni pueden tumbar el webhook.
    // El finally cubre los ~12 returns tempranos. Solo se persiste lo que
    // hizo match con el producto.
    if (ctx.matched) {
      after(async () => {
        try {
          await logWebhook({
            orderId: String(ctx.orderId),
            rid,
            ms: Date.now() - t0,
            payload: ctx.payload,
            steps,
          });
        } catch (err) {
          console.log(`[wh ${rid}] webhook log FAILED`, serr(err));
        }
      });
    }
  }
}

async function handle(req: NextRequest, log: Log, ctx: Ctx): Promise<NextResponse> {
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
  log('1 hmac.ok');

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
  ctx.orderId = orderId;

  // ── 3. Filtro por product_id ──────────────────────────────────────
  const requiredProductId = process.env.SHOPIFY_SUBSCRIPTION_PRODUCT_ID;
  log('2 parse.ok', { orderId, lineItems: order.line_items.map((li) => li.product_id) });
  if (requiredProductId && !order.line_items.some((li) => String(li.product_id) === requiredProductId)) {
    log('3 product.mismatch — SKIP', { requiredProductId, got: order.line_items.map((li) => li.product_id) });
    return NextResponse.json({ ok: true, skipped: 'product_mismatch' });
  }
  ctx.matched = true;
  ctx.payload = raw; // se guarda en el after() del POST, fuera del camino critico
  log('3 product.match ok', { requiredProductId: requiredProductId || '(todos)' });

  // ── 4. Dedup ──────────────────────────────────────────────────────
  if (await isDuplicateAttempt(orderId)) {
    log('4 dedup.duplicate — SKIP, ya procesado, no se reenvia email', { orderId });
    return NextResponse.json({ ok: true, duplicate: true });
  }
  log('4 dedup.new');

  // ── 5. Email + validar suscripción ───────────────────────────────
  const email = extractBuyerEmail(order);
  if (!email) {
    log('5 buyer.no_email — SKIP');
    return NextResponse.json({ ok: true, skipped: 'no_email' });
  }
  const isSubscription = requiredProductId ? true : isSubscriptionOrder(order);
  if (!isSubscription) {
    log('5 buyer.not_subscription — SKIP');
    return NextResponse.json({ ok: true, skipped: 'not_subscription' });
  }

  const name = extractBuyerName(order);
  const shopifyCustomerId = extractShopifyCustomerId(order);
  const shopifySellingPlanId = extractSellingPlanId(order);
  const paidAt = new Date();
  const periodEnd = new Date(paidAt.getTime() + membershipDurationMs());
  log('5 buyer.ok', { email, name, shopifyCustomerId, periodEnd });

  // ── 6. Registrar intento ──────────────────────────────────────────
  await createAttempt(orderId);
  log('6 attempt.created');

  const fail = async (error: string) => {
    log('FAIL 500 — Shopify reintentara', { reason: error });
    await markAttemptFailed(orderId, error);
    return NextResponse.json({ ok: false }, { status: 500 });
  };

  // ── 7. Circle: buscar → crear ─────────────────────────────────────
  // ponytail: findOrCreateMember va inline para poder loguear la busqueda y
  // la creacion por separado. Los demas callers siguen usando el helper.
  let circleMember: { id: number; created: boolean };
  try {
    const existing = await findMemberByEmail(email);
    log('7a circle.search', { email, found: !!existing, circleMemberId: existing?.id ?? null });
    if (existing) {
      circleMember = { id: existing.id, created: false };
      log('7b circle.reuse — ya estaba en Circle, no se crea ni se reinvita', {
        circleMemberId: existing.id, circleName: existing.name,
      });
    } else {
      // Circle manda su propia invitacion al crear el miembro (no pasamos
      // skip_invitation). La API no confirma el envio en la respuesta.
      const created = await createMember(email, name ?? undefined);
      circleMember = { id: created.id, created: true };
      log('7b circle.create — miembro NUEVO creado, Circle dispara su invitacion', {
        circleMemberId: created.id, circleName: created.name,
      });
    }
  } catch (err) {
    log('7 circle.member FAILED', { error: serr(err) });
    return fail('circle_member');
  }

  // ── 8. Circle: agregar al grupo de suscripción ───────────────────
  try {
    await addToSubscriptionGroup(email);
    log('8 circle.group.add ok — acceso a la comunidad', {
      email, groupId: process.env.CIRCLE_ACCESS_GROUP_ID,
    });
  } catch (err) {
    log('8 circle.group.add FAILED', { error: serr(err) });
    return fail('circle_group');
  }

  // ── 9. DB: upsert miembro + pago ─────────────────────────────────
  // Renovacion si ya estaba en Circle o en la BD. Solo se salta el correo
  // cuando es nuevo en ambos. memberExists va ANTES del upsert, que es
  // justo lo que crea la fila.
  const inDb = await memberExists(email);
  const isRenewal = !circleMember.created || inDb;
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
    log('9 db.upsert ok', { expiresAt, periodEnd, isRenewal, inCircle: !circleMember.created, inDb });
  } catch (err) {
    log('9 db.upsert FAILED', { error: serr(err) });
    return fail('db_upsert');
  }

  await markAttemptCompleted(orderId);
  log('9b attempt.completed');

  // ── 10. Email de renovación ──────────────────────────────────────
  // Solo a quienes ya existían en Circle: al miembro nuevo lo recibe el
  // onboarding de Circle, este correo dice "se renovó" y no aplica.
  if (!isRenewal) {
    log('10 email.skip — nuevo en Circle y en la BD, lo da la bienvenida Circle', { to: email });
  } else {
    try {
      log('10 email.sending', { to: email, from: emailFrom() });
      const id = await sendSubscriptionConfirmation(email, name ?? null, expiresAt);
      log('10 email.sent', { to: email, resendId: id });
    } catch (err) {
      log('10 email.FAILED', { to: email, from: emailFrom(), error: serr(err) });
    }
  }

  // ponytail: awaited a proposito — en serverless la funcion se congela al
  // hacer return y las promesas sueltas nunca corren.
  if (!shopifyCustomerId) {
    // La membresia queda completa igual; lo unico que falta es el contract_id
    // para poder cancelar la suscripcion en Shopify mas adelante.
    log('11 contract.skip — el pedido no trae customer.id', { orderId });
  } else {
    try {
      const contractId = await findSubscriptionContractId(shopifyCustomerId);
      if (contractId) await saveSubscriptionContractId(orderId, contractId);
      log('11 contract.lookup', {
        contractId,
        shopifyCustomerId,
        // findSubscriptionContractId devuelve null si faltan estas env vars,
        // igual que si el cliente no tuviera contrato. Se distinguen aqui.
        shopifyApiConfigured: Boolean(process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_ADMIN_TOKEN),
      });
    } catch (err) {
      log('11 contract.lookup FAILED', { error: serr(err) });
    }
  }

  if (process.env.CIRCLE_PREMIUM_GROUP_ID) {
    try {
      const streak = await getMemberStreak(email);
      const promote = streak >= premiumStreakThreshold();
      if (promote) await addToPremiumGroup(email);
      log('12 premium.check', { streak, threshold: premiumStreakThreshold(), promote });
    } catch (err) {
      log('12 premium.check FAILED', { error: serr(err) });
    }
  }

  log('13 done ok');
  return NextResponse.json({ ok: true, orderId });
}
