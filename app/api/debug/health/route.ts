import { NextResponse } from 'next/server';
import { isAxiosError } from 'axios';
import { circleRequest, communityId } from '@/lib/circle/_client';
import { Resend } from 'resend';

const disabled = () =>
  NextResponse.json({ error: 'Debug endpoint disabled. Set DEBUG_HEALTH=true to enable.' }, { status: 403 });

async function checkCircle() {
  const cid = communityId();
  const url = `https://app.circle.so/api/admin/v2/communities/${cid}`;
  try {
    const data = await circleRequest<{ id: number; name: string }>('GET', `/communities/${cid}`);
    return { ok: true, community: { id: data.id, name: data.name } };
  } catch (err: unknown) {
    if (isAxiosError(err)) {
      return {
        ok: false,
        config: { url, communityId: cid, apiKeySet: !!process.env.CIRCLE_API_KEY },
        httpStatus: err.response?.status ?? null,
        circleError: err.response?.data ?? null,
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

export async function GET() {
  if (process.env.DEBUG_HEALTH !== 'true') return disabled();

  const [circle, email] = await Promise.all([checkCircle(), checkEmail()]);

  const status = circle.ok && email.ok ? 200 : 207;
  return NextResponse.json({ circle, email }, { status });
}
