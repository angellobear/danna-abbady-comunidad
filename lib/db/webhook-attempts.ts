import { adminClient } from '@/lib/supabase';

export async function isDuplicateAttempt(orderId: string): Promise<boolean> {
  const { data } = await adminClient()
    .from('webhook_attempts')
    .select('status')
    .eq('shopify_order_id', orderId)
    .maybeSingle();
  return data?.status === 'completed';
}

export async function createAttempt(orderId: string): Promise<void> {
  await adminClient()
    .from('webhook_attempts')
    .insert({ shopify_order_id: orderId, status: 'processing' });
}

export async function markAttemptCompleted(orderId: string): Promise<void> {
  await adminClient()
    .from('webhook_attempts')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('shopify_order_id', orderId);
}

export async function markAttemptFailed(orderId: string, error: string): Promise<void> {
  await adminClient()
    .from('webhook_attempts')
    .update({ status: 'failed', error: error.slice(0, 500), completed_at: new Date().toISOString() })
    .eq('shopify_order_id', orderId);
}
