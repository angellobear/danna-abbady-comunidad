import { NextResponse } from 'next/server';
import { isAxiosError } from 'axios';
import { circleRequest, communityId, isCircleStatus } from '@/lib/circle/_client';
import { adminClient } from '@/lib/supabase';
import { Resend } from 'resend';
import { from } from '@/lib/email';

const TEST_TO = 'angello@blubear.io';

const disabled = () =>
  NextResponse.json({ error: 'Debug endpoint disabled. Set DEBUG_HEALTH=true to enable.' }, { status: 403 });

async function checkCircle() {
  const cid = communityId();
  const path = `/community_members/search?community_id=${cid}&email=health%40check.local&per_page=1`;
  const url = `https://app.circle.so/api/admin/v2${path}`;
  try {
    await circleRequest('GET', path);
    return { ok: true, config: { url, communityId: cid } };
  } catch (err: unknown) {
    // 404 = email no encontrado → API alcanzable y credenciales válidas
    if (isCircleStatus(err, 404)) return { ok: true, config: { url, communityId: cid } };
    if (isAxiosError(err)) {
      return {
        ok: false,
        config: { url, communityId: cid, apiKeySet: !!process.env.CIRCLE_API_KEY },
        httpStatus: err.response?.status ?? null,
        circleError: typeof err.response?.data === 'string'
          ? `HTML error page (status ${err.response.status})`
          : (err.response?.data ?? null),
        message: err.message,
      };
    }
    return { ok: false, config: { url, communityId: cid, apiKeySet: !!process.env.CIRCLE_API_KEY }, message: String(err) };
  }
}

async function checkEmail() {
  const key = process.env.RESEND_API_KEY;
  const sender = from();
  if (!key) {
    console.error({ event: 'health.email_failed', error: 'RESEND_API_KEY not set' });
    return { ok: false, from: sender, error: 'RESEND_API_KEY not set' };
  }
  const resend = new Resend(key);
  try {
    const { data: domains, error: domErr } = await resend.domains.list();
    if (domErr) throw new Error(`domains.list: ${domErr.name} — ${domErr.message}`);

    // envío real de prueba: valida el remitente, no solo las credenciales
    const { data: sent, error: sendErr } = await resend.emails.send({
      from: sender,
      to: TEST_TO,
      subject: 'Health check — comunidad Danna Abbady',
      text: `Envío de prueba desde /api/debug/health. Remitente: ${sender}`,
    });
    if (sendErr) throw new Error(`emails.send: ${sendErr.name} — ${sendErr.message}`);

    console.log('[health] test email sent', { to: TEST_TO, id: sent?.id, from: sender });
    return {
      ok: true,
      from: sender,
      domains: domains?.data?.map((d: { name: string }) => d.name) ?? [],
      testEmail: { to: TEST_TO, id: sent?.id ?? null },
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    console.error({ event: 'health.email_failed', from: sender, to: TEST_TO, error });
    return { ok: false, from: sender, testEmail: { to: TEST_TO }, error };
  }
}

async function checkSupabase() {
  try {
    // Verifica que la tabla members existe y la RPC upsert_member_payment está disponible
    const { error: tableErr } = await adminClient().from('members').select('email').limit(1);
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
