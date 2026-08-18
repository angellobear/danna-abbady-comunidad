import { NextResponse } from 'next/server';
import { circleRequest, communityId } from '@/lib/circle/_client';
import { Resend } from 'resend';

const disabled = () =>
  NextResponse.json({ error: 'Debug endpoint disabled. Set DEBUG_HEALTH=true to enable.' }, { status: 403 });

async function checkCircle() {
  try {
    const data = await circleRequest<{ id: number; name: string }>('GET', `/communities/${communityId()}`);
    return { ok: true, community: { id: data.id, name: data.name } };
  } catch (err: unknown) {
    return { ok: false, error: String(err) };
  }
}

async function checkEmail() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: 'RESEND_API_KEY not set' };
  try {
    const resend = new Resend(key);
    // Validate key by hitting the domains list — no email sent
    const { error } = await resend.domains.list();
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: String(err) };
  }
}

export async function GET() {
  if (process.env.DEBUG_HEALTH !== 'true') return disabled();

  const [circle, email] = await Promise.all([checkCircle(), checkEmail()]);

  const status = circle.ok && email.ok ? 200 : 207;
  return NextResponse.json({ circle, email }, { status });
}
