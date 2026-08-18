import { circleRequest, communityId, isCircleStatus } from './_client';

export type CircleMember = { id: number; email: string; name: string | null };

// Circle Admin v2 crea miembros con esta envoltura en la respuesta POST
type CreateMemberResponse = { community_member: CircleMember } | CircleMember;

function unwrapMember(data: CreateMemberResponse): CircleMember {
  return 'community_member' in data ? data.community_member : data;
}

export async function findMemberByEmail(email: string): Promise<CircleMember | null> {
  const params = new URLSearchParams({ email, community_id: String(communityId()) });
  try {
    const data = await circleRequest<CircleMember[] | { community_members: CircleMember[] }>(
      'GET',
      `/community_members/search?${params}`,
    );
    const list = Array.isArray(data) ? data : (data.community_members ?? []);
    return list[0] ?? null;
  } catch (err) {
    // 404 = no encontrado (Circle lo trata como error, no como lista vacía)
    if (isCircleStatus(err, 404)) return null;
    throw err;
  }
}

export async function createMember(email: string, name?: string): Promise<CircleMember> {
  try {
    const data = await circleRequest<CreateMemberResponse>('POST', '/community_members', {
      email,
      name: name ?? email.split('@')[0],
      community_id: communityId(),
    });
    return unwrapMember(data);
  } catch (err) {
    // 422 = race condition: fue creado mientras hacíamos el search
    if (isCircleStatus(err, 422)) {
      const existing = await findMemberByEmail(email);
      if (existing) return existing;
    }
    throw err;
  }
}

/** Idempotente: retorna el existente o crea uno nuevo. */
export async function findOrCreateMember(email: string, name?: string): Promise<CircleMember> {
  return (await findMemberByEmail(email)) ?? createMember(email, name);
}

export async function updateMember(
  id: number,
  data: Partial<{ name: string; headline: string }>,
): Promise<CircleMember> {
  const res = await circleRequest<CreateMemberResponse>('PUT', `/community_members/${id}`, {
    ...data,
    community_id: communityId(),
  });
  return unwrapMember(res);
}

export async function getMemberById(id: number): Promise<CircleMember> {
  return circleRequest<CircleMember>('GET', `/community_members/${id}?community_id=${communityId()}`);
}

export async function deactivateMember(id: number): Promise<void> {
  try {
    await circleRequest<void>('DELETE', `/community_members/${id}`);
  } catch (err) {
    if (isCircleStatus(err, 404)) return;
    throw err;
  }
}
