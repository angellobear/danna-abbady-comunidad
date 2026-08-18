import { NextRequest, NextResponse } from 'next/server';
import { getExpiredActiveMembers, setMemberInactive } from '@/lib/db/members';
import { removeFromSubscriptionGroup, removeFromPremiumGroup } from '@/lib/circle/access-groups';

// Cada hora: desactiva miembros expirados en Circle y Supabase.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const expired = await getExpiredActiveMembers();
  const results: { email: string; ok: boolean; error?: string }[] = [];

  for (const member of expired) {
    try {
      if (member.circle_member_id) {
        await removeFromSubscriptionGroup(member.circle_member_id);
        await removeFromPremiumGroup(member.circle_member_id);
      }
      await setMemberInactive(member.email);
      results.push({ email: member.email, ok: true });
    } catch (err) {
      console.error('[cron:expire] failed for', member.email, err);
      results.push({ email: member.email, ok: false, error: String(err) });
    }
  }

  console.log('[cron:expire] processed', results.length, 'expired members');
  return NextResponse.json({ processed: results.length, results });
}
