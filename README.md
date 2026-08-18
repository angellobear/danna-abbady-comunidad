# dana-circle

Integración **Shopify → Circle** para gestionar acceso a la comunidad de Danna Abbady según suscripción activa.

Stack: **Next.js 16**, **Supabase**, **Circle Admin API V2**, **Zod**, **Axios**

---

## Flujo principal

```
① Usuario paga en Shopify → dispara orders/paid webhook
② Webhook verifica HMAC-SHA256 (timing-safe) → 401 si falla
③ Dedup: ¿este order_id ya está completed? → 200 OK si sí
④ Extraer email (3 fallbacks: order.email → contact_email → customer.email)
⑤ Filtrar por SHOPIFY_SUBSCRIPTION_PRODUCT_ID (o detecting selling_plan_id)
⑥ Registrar intento en webhook_attempts
⑦ Circle: find-or-create member → add to access group (409 = ok)
⑧ DB: upsert_member_payment con advisory lock por email
⑨ Marcar attempt como completed
⑩ [Non-blocking] Si streak ≥ PREMIUM_STREAK_MONTHS → add to premium group
```

Dos crons en Vercel:
- **Cada hora** `/api/cron/expire-memberships` → desactiva miembros cuyo `expires_at` ya pasó
- **Cada día 9am** `/api/cron/sync-premium` → sincroniza grupo premium según racha de pagos consecutivos

---

## Setup

```bash
npm install
cp .env.local.example .env.local
# completar variables en .env.local
```

### Variables de entorno

Ver `.env.local.example` para la lista completa.

### Base de datos

```bash
supabase db push
# o correr manualmente en Supabase SQL Editor:
# supabase/migrations/20260806000000_schema.sql
# supabase/migrations/20260806000001_functions.sql
```

### Webhook en Shopify

Registrar en Shopify Admin → Notifications → Webhooks:
- **Topic:** `orders/paid`
- **URL:** `https://tudominio.com/api/webhooks/shopify/comunidad`

---

## Estructura

```
app/api/
  cron/expire-memberships/route.ts   # hourly: desactiva expirados
  cron/sync-premium/route.ts         # daily: sincroniza grupo premium
  webhooks/shopify/comunidad/route.ts

lib/
  supabase.ts          # adminClient()
  config.ts            # membershipDurationMs(), premiumStreakThreshold()
  schemas/
    shopify-subscription.ts
  circle/
    _client.ts         # circleRequest + isCircleStatus
    members.ts         # findOrCreateMember, deactivateMember
    access-groups.ts   # addToSubscriptionGroup, addToPremiumGroup, remove*
    index.ts
  db/
    members.ts         # getExpiredActiveMembers, upsertMemberPayment, getMemberStreak
    webhook-attempts.ts

supabase/migrations/
  20260806000000_schema.sql    # tables: members, subscription_payments, webhook_attempts
  20260806000001_functions.sql # get_member_streak + upsert_member_payment
```

---

## Principios

- **Circle antes del commit en DB.** Si Circle falla → 500 → Shopify reintenta (19× en 48h).
- **Transacción atómica.** `upsert_member_payment` usa advisory lock por email.
- **El acceso lo controla la DB.** `members.expires_at > now()` es la fuente de verdad. Circle es la experiencia.
- **Membresía configurable.** `MEMBERSHIP_DURATION=30d` (soporta 30d, 15h, 1h, 30m). `PREMIUM_STREAK_MONTHS=3`.
