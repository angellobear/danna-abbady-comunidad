import { circleRequest, communityId, isCircleStatus } from './_client';

/** 409 = ya está en el grupo → ok. */
export async function addMemberToGroup(groupId: number, email: string): Promise<void> {
  try {
    await circleRequest<void>('POST', `/access_groups/${groupId}/community_members`, {
      email,
      community_id: communityId(),
    });
  } catch (err) {
    if (isCircleStatus(err, 409)) return;
    throw err;
  }
}

export async function removeMemberFromGroup(groupId: number, memberId: number): Promise<void> {
  try {
    await circleRequest<void>('DELETE', `/access_groups/${groupId}/community_members`, {
      community_member_id: memberId,
      community_id: communityId(),
    });
  } catch (err) {
    if (isCircleStatus(err, 404)) return;
    throw err;
  }
}

export async function listGroupMembers(groupId: number): Promise<unknown[]> {
  return circleRequest<unknown[]>(
    'GET',
    `/access_groups/${groupId}/community_members?community_id=${communityId()}`,
  );
}

export const addToSubscriptionGroup = (email: string) =>
  addMemberToGroup(Number(process.env.CIRCLE_ACCESS_GROUP_ID), email);

export const removeFromSubscriptionGroup = (memberId: number) =>
  removeMemberFromGroup(Number(process.env.CIRCLE_ACCESS_GROUP_ID), memberId);

export const addToPremiumGroup = (email: string) =>
  addMemberToGroup(Number(process.env.CIRCLE_PREMIUM_GROUP_ID), email);

export const removeFromPremiumGroup = (memberId: number) =>
  removeMemberFromGroup(Number(process.env.CIRCLE_PREMIUM_GROUP_ID), memberId);
