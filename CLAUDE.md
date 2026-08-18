@AGENTS.md

# Contexto del proyecto

Backend de integración Shopify → Circle para la comunidad de Danna Abbady.
Procesa pagos de Shopify, registra membresías en Supabase y gestiona acceso en Circle.

## Stack

- **Next.js 16** (app router, route handlers) — `@/*` resuelve a la raíz del proyecto
- **Supabase** (DB con service role)
- **Circle Admin API V2** — gestión de miembros y grupos de acceso
- **Zod** (validación de schemas)
- **Axios** (todos los requests a Circle)

## Estructura de `lib/`

```
lib/
  supabase.ts          # adminClient() — service role, server-only
  config.ts            # membershipDurationMs(), premiumStreakThreshold()
  schemas/
    shopify-subscription.ts  # Zod schema + extractBuyerEmail, extractBuyerName, isSubscriptionOrder
  circle/
    _client.ts         # circleRequest() [Admin API V2] + communityId() + isCircleStatus()
    members.ts         # findMemberByEmail, createMember, findOrCreateMember, updateMember, getMemberById, deactivateMember
    access-groups.ts   # addMemberToGroup, removeMemberFromGroup, addToSubscriptionGroup, addToPremiumGroup, remove*
    index.ts           # re-export todo
  db/
    members.ts         # getExpiredActiveMembers, getActiveMembers, setMemberInactive, getMemberStreak, upsertMemberPayment
    webhook-attempts.ts # isDuplicateAttempt, createAttempt, markAttemptCompleted, markAttemptFailed
```

## API Routes

```
GET  /                               # health check → { ok: true }
GET  /api/cron/expire-memberships    # hourly: desactiva miembros expirados + los quita de Circle
GET  /api/cron/sync-tiers            # daily: sincroniza grupos de acceso según racha (3m hoy; 6m/12m futuro)
POST /api/webhooks/shopify/comunidad # pago Shopify → Circle + Supabase
```

## Webhook Shopify (flujo de 10 pasos)

`app/api/webhooks/shopify/comunidad/route.ts`:
1. HMAC verify (timing-safe)
2. Parse + Zod validate
3. Filtro por SHOPIFY_SUBSCRIPTION_PRODUCT_ID
4. Dedup: isDuplicateAttempt(orderId) → skip si ya completed
5. Extraer email + validar tipo suscripción
6. createAttempt(orderId)
7. Circle: findOrCreateMember → **falla → 500 (Shopify reintenta)**
8. Circle: addToSubscriptionGroup → **falla → 500**
9. DB: upsertMemberPayment (advisory lock por email)
10. markAttemptCompleted + [non-blocking] premium check si CIRCLE_PREMIUM_GROUP_ID

## Patrones críticos

### Supabase admin

Siempre `adminClient()` de `@/lib/supabase`. No crear `createClient()` en otros archivos.

### Circle errors

Los errores HTTP de Circle son `AxiosError`. Usar `isCircleStatus(err, N)`.
- 409 en addMemberToGroup = ya está en el grupo → ok, silenciado
- 404 en removeMemberFromGroup = no está → ok, silenciado
- 422 en createMember = race condition → retry findMemberByEmail

### Membresía configurable

`lib/config.ts` lee env vars:
- `MEMBERSHIP_DURATION` (default `30d`) — formatos: 30d, 15h, 1h, 30m, 60s
- `PREMIUM_STREAK_MONTHS` (default `3`) — meses consecutivos requeridos para premium

## Variables de entorno

```
SHOPIFY_WEBHOOK_SECRET
SHOPIFY_SUBSCRIPTION_PRODUCT_ID   # vacío = acepta todos
CIRCLE_API_KEY
CIRCLE_COMMUNITY_ID
CIRCLE_ACCESS_GROUP_ID
CIRCLE_PREMIUM_GROUP_ID           # opcional; si vacío, no se evalúa premium
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
NEXT_PUBLIC_APP_URL
CRON_SECRET
MEMBERSHIP_DURATION               # default 30d
PREMIUM_STREAK_MONTHS             # default 3
```

## Migraciones SQL

```
supabase/migrations/
  20260806000000_schema.sql    # members, subscription_payments, webhook_attempts + índices + trigger updated_at
  20260806000001_functions.sql # get_member_streak() + upsert_member_payment() con advisory lock
```

## Streak de membresía

`getMemberStreak(email)` → RPC `get_member_streak` en Supabase.
Cuenta pagos consecutivos con 3 días de gracia entre períodos.
≥ PREMIUM_STREAK_MONTHS → elegible para grupo premium.

## Dev tools

```bash
# Script de seed (requiere RESEND_API_KEY opcional):
npx tsx scripts/seed-test-member.ts
```
