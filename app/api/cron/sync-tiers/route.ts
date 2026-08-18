import { NextRequest, NextResponse } from 'next/server';
import { getActiveMembers, getMemberStreak } from '@/lib/db/members';
import { addToPremiumGroup, removeFromPremiumGroup } from '@/lib/circle/access-groups';
import { premiumStreakThreshold } from '@/lib/config';

// ponytail: un solo tier hoy. Cuando existan 6m y 12m, añadir:
//   CIRCLE_TIER_6M_GROUP_ID, CIRCLE_TIER_12M_GROUP_ID en .env
//   y funciones addToTier6mGroup / addToTier12mGroup en access-groups.ts

export async function runSyncTiers() {
  const members = await getActiveMembers();
  const results: { email: string; streak: number; action: 'added' | 'removed' | 'none' | 'error' }[] = [];

  for (const member of members) {
    if (!member.circle_member_id) continue;
    try {
      const streak = await getMemberStreak(member.email);
      if (streak >= premiumStreakThreshold()) {
        await addToPremiumGroup(member.email);
        results.push({ email: member.email, streak, action: 'added' });
      } else {
        await removeFromPremiumGroup(member.circle_member_id);
        results.push({ email: member.email, streak, action: 'removed' });
      }
    } catch (err) {
      console.error('[cron:sync-tiers] failed for', member.email, err);
      results.push({ email: member.email, streak: 0, action: 'error' });
    }
  }

  console.log('[cron:sync-tiers] synced', results.length, 'members');
  return { processed: results.length, results };
}

// Diario: sincroniza grupos de acceso en Circle según racha de pagos consecutivos.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(await runSyncTiers());
}
