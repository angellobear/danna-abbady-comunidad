import axios, { isAxiosError } from 'axios';

const BASE = 'https://app.circle.so/api/admin/v2';

export const communityId = () => Number(process.env.CIRCLE_COMMUNITY_ID);

const authHeaders = () => ({
  Authorization: `Token ${process.env.CIRCLE_API_KEY}`,
  'Content-Type': 'application/json',
});

export async function circleRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await axios<T>({
    method,
    url: `${BASE}${path}`,
    headers: authHeaders(),
    ...(body !== undefined ? { data: body } : {}),
  });
  return res.data;
}

/** Verifica el HTTP status de un AxiosError. */
export const isCircleStatus = (err: unknown, status: number): boolean =>
  isAxiosError(err) && err.response?.status === status;
