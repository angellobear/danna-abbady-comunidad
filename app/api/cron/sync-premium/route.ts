import { NextRequest, NextResponse } from 'next/server';
import { getActiveMembers, getMemberStreak } from '@/lib/db/members';
import { addToPremiumGroup, removeFromPremiumGroup } from '@/lib/circle/access-groups';
import { premiumStreakThreshold } from '@/lib/config';

// Diario: sincroniza grupo premium según racha de pagos consecutivos.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
      console.error('[cron:premium] failed for', member.email, err);
      results.push({ email: member.email, streak: 0, action: 'error' });
    }
  }

  console.log('[cron:premium] synced', results.length, 'members');
  return NextResponse.json({ processed: results.length, results });
}
