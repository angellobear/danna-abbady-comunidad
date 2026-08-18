const UNITS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

function parseDuration(val: string): number {
  const match = val.match(/^(\d+)(d|h|m|s)$/);
  if (!match) throw new Error(`Invalid duration: "${val}" — expected e.g. 30d, 15h, 30m`);
  return parseInt(match[1]) * UNITS[match[2]];
}

/** Ms de duración de membresía. Default 30d. Env: MEMBERSHIP_DURATION=30d|15h|1h|30m */
export function membershipDurationMs(): number {
  return parseDuration(process.env.MEMBERSHIP_DURATION ?? '30d');
}

/** Pagos consecutivos requeridos para premium. Default 3. Env: PREMIUM_STREAK_MONTHS=3 */
export function premiumStreakThreshold(): number {
  return parseInt(process.env.PREMIUM_STREAK_MONTHS ?? '3');
}
