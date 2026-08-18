import { NextRequest, NextResponse } from 'next/server';
import { runExpireMemberships } from '@/app/api/cron/expire-memberships/route';
import { runSyncTiers } from '@/app/api/cron/sync-tiers/route';

// Único cron registrado en Vercel (plan free). Corre cada hora.
// - expire: siempre
// - premium sync: solo a las 9am UTC
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const expire = await runExpireMemberships();

  const tiers = await runSyncTiers();

  return NextResponse.json({ expire, tiers });
}
