import type { Redis } from 'ioredis';

/**
 * Mass-export anomaly rule (MASTER-PLAN.md §6 "Detection & response: anomaly
 * rules (velocity, geo, privilege change, mass export)"): flags an actor who
 * pages through an unusual number of audit/security-event listing requests
 * in a short window — a data-exfiltration signal distinct from ordinary
 * admin-screen browsing. A Redis fixed-window counter, not a DB query: this
 * runs on every read of what are meant to be lightweight list endpoints, so
 * it must not itself add a write to the primary database on the common
 * (non-anomalous) path.
 */
const WINDOW_SECONDS = 300;
const THRESHOLD = 30;

export async function recordListAccessAndCheckMassExport(
  redis: Redis,
  tenantId: string,
  actorUserId: string,
  resource: 'audit_events' | 'security_events',
): Promise<boolean> {
  const key = `mass-export-check:${tenantId}:${actorUserId}:${resource}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, WINDOW_SECONDS);
  }
  return count === THRESHOLD; // fire exactly once per window, at the moment the threshold is crossed
}
