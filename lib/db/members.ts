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

/** Racha de meses consecutivos de membresía activa. */
export async function getMemberStreak(email: string): Promise<number> {
  const { data, error } = await adminClient().rpc('get_member_streak', { p_email: email });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** Upsert atómico de miembro + pago. Usa advisory lock en la DB. */
export async function upsertMemberPayment(params: {
  email: string;
  name: string | null;
  circleId: number;
  orderId: string;
  paidAt: Date;
  periodEnd: Date;
}): Promise<void> {
  const { error } = await adminClient().rpc('upsert_member_payment', {
    p_email:      params.email,
    p_name:       params.name,
    p_circle_id:  params.circleId,
    p_order_id:   params.orderId,
    p_paid_at:    params.paidAt.toISOString(),
    p_period_end: params.periodEnd.toISOString(),
  });
  if (error) throw error;
}
