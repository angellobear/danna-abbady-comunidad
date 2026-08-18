import { NextResponse } from 'next/server';
import { isAxiosError } from 'axios';
import { circleRequest, communityId } from '@/lib/circle/_client';
import { adminClient } from '@/lib/supabase';
import { Resend } from 'resend';

const disabled = () =>
  NextResponse.json({ error: 'Debug endpoint disabled. Set DEBUG_HEALTH=true to enable.' }, { status: 403 });

async function checkCircle() {
  const cid = communityId();
  const path = `/community_members/search?community_id=${cid}&per_page=1`;
  const url = `https://app.circle.so/api/admin/v2${path}`;
  try {
    await circleRequest('GET', path);
    return { ok: true, config: { url, communityId: cid } };
  } catch (err: unknown) {
    if (isAxiosError(err)) {
      return {
        ok: false,
        config: { url, communityId: cid, apiKeySet: !!process.env.CIRCLE_API_KEY },
        httpStatus: err.response?.status ?? null,
        // Si la respuesta es HTML (página de error), solo mostramos el status
        circleError: typeof err.response?.data === 'string' ? `HTML error page (status ${err.response.status})` : (err.response?.data ?? null),
        message: err.message,
      };
    }
    return { ok: false, config: { url, communityId: cid, apiKeySet: !!process.env.CIRCLE_API_KEY }, message: String(err) };
  }
}

async function checkEmail() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: 'RESEND_API_KEY not set' };
  try {
    const { data, error } = await new Resend(key).domains.list();
    if (error) return { ok: false, error: error.message };
    return { ok: true, domains: data?.data?.map((d: { name: string }) => d.name) ?? [] };
  } catch (err: unknown) {
    return { ok: false, error: String(err) };
  }
}

async function checkSupabase() {
  try {
    // Verifica que la tabla members existe y la RPC upsert_member_payment está disponible
    const { error: tableErr } = await adminClient().from('members').select('id').limit(1);
    if (tableErr) return { ok: false, step: 'members_table', error: tableErr.message, code: tableErr.code };

    const { error: rpcErr } = await adminClient().rpc('get_member_streak', { p_email: '__health_check__' });
    // PGRST202 = función no existe; cualquier otro error significa que sí existe
    if (rpcErr && rpcErr.code === 'PGRST202') {
      return { ok: false, step: 'get_member_streak_rpc', error: 'RPC not found — run migrations', code: rpcErr.code };
    }

    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: String(err) };
  }
}

export async function GET() {
  if (process.env.DEBUG_HEALTH !== 'true') return disabled();

  const [circle, email, supabase] = await Promise.all([checkCircle(), checkEmail(), checkSupabase()]);

  const status = circle.ok && email.ok && supabase.ok ? 200 : 207;
  return NextResponse.json({ circle, email, supabase }, { status });
}
