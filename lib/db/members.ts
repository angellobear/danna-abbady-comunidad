import { adminClient } from '@/lib/supabase';

export type MemberRow = {
  email: string;
  name: string | null;
  circle_member_id: number | null;
  status: 'active' | 'inactive';
  expires_at: string | null;
};

/** Miembros activos cuya membresía ya expiró. */
export async function getExpiredActiveMembers(): Promise<MemberRow[]> {
  const { data, error } = await adminClient()
    .from('members')
    .select('email, name, circle_member_id, status, expires_at')
    .eq('status', 'active')
    .lt('expires_at', new Date().toISOString());
  if (error) throw error;
  return (data ?? []) as MemberRow[];
}

/** Todos los miembros activos (para chequeo de premium). */
export async function getActiveMembers(): Promise<MemberRow[]> {
  const { data, error } = await adminClient()
    .from('members')
    .select('email, name, circle_member_id, status, expires_at')
    .eq('status', 'active');
  if (error) throw error;
  return (data ?? []) as MemberRow[];
}

export async function setMemberInactive(email: string): Promise<void> {
  const { error } = await adminClient()
    .from('members')
    .update({ status: 'inactive' })
    .eq('email', email);
  if (error) throw error;
}

/**
 * ¿Ya existía este miembro antes del pago actual? Es la señal de renovación:
 * Circle puede reportar `created` en alguien que ya era miembro y fue borrado
 * de la comunidad, así que ese flag no sirve para decidirlo.
 */
export async function memberExists(email: string): Promise<boolean> {
  const { data, error } = await adminClient()
    .from('members')
    .select('email')
    .eq('email', email)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/** Racha de meses consecutivos de membresía activa. */
export async function getMemberStreak(email: string): Promise<number> {
  const { data, error } = await adminClient().rpc('get_member_streak', { p_email: email });
  if (error) throw error;
  return (data as number) ?? 0;
}

/**
 * Upsert atómico de miembro + pago. Usa advisory lock en la DB.
 * Devuelve el expires_at acumulado — no es paidAt + duración cuando el
 * miembro ya tenía días vigentes.
 */
export async function upsertMemberPayment(params: {
  email: string;
  name: string | null;
  circleId: number;
  orderId: string;
  paidAt: Date;
  periodEnd: Date;
  shopifyCustomerId?: string | null;
  shopifySellingPlanId?: string | null;
}): Promise<Date> {
  const { data, error } = await adminClient().rpc('upsert_member_payment', {
    p_email:                  params.email,
    p_name:                   params.name,
    p_circle_id:              params.circleId,
    p_order_id:               params.orderId,
    p_paid_at:                params.paidAt.toISOString(),
    p_period_end:             params.periodEnd.toISOString(),
    p_shopify_customer_id:    params.shopifyCustomerId ?? null,
    p_shopify_selling_plan:   params.shopifySellingPlanId ?? null,
  });
  if (error) throw error;
  return data ? new Date(data as string) : params.periodEnd;
}

export async function logWebhookPayload(orderId: string, payload: unknown): Promise<void> {
  await adminClient().from('shopify_webhook_logs').insert({ shopify_order_id: orderId, payload });
}

export async function saveSubscriptionContractId(
  orderId: string,
  contractId: string,
): Promise<void> {
  const { error } = await adminClient()
    .from('subscription_payments')
    .update({ shopify_subscription_contract_id: contractId })
    .eq('shopify_order_id', orderId);
  if (error) throw error;
}
