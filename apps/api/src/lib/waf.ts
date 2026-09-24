import { AppError } from '@ai-concierge/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * MASTER-PLAN.md §6 Phase 6 "Edge: … WAF rules (body size, schema, IP lists,
 * bot signals)". Body-size and schema validation already exist (API_BODY_LIMIT_BYTES,
 * Zod route schemas); this adds the bot-signal check: reject known
 * vulnerability-scanner user agents before they reach any route handler.
 * Deliberately a small, explicit denylist rather than a general bot-
 * detection heuristic — those have real false-positive risk (legitimate
 * monitoring/uptime tools, corporate proxies) that isn't worth taking on
 * for a rule this narrow in scope.
 */
const BLOCKED_USER_AGENT_PATTERNS = [
  /sqlmap/i,
  /nikto/i,
  /nessus/i,
  /acunetix/i,
  /nmap/i,
  /masscan/i,
  /\bzgrab\b/i,
  /openvas/i,
];

export async function rejectKnownScannerUserAgents(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const userAgent = request.headers['user-agent'];
  if (userAgent && BLOCKED_USER_AGENT_PATTERNS.some((pattern) => pattern.test(userAgent))) {
    throw new AppError('FORBIDDEN', 'Request blocked');
  }
}
