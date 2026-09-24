import { classifyPII, SecurityEventType, SecuritySeverity } from '@ai-concierge/domain';
import { recordSecurityEvent, withTenantContext, type PrismaClient } from '@ai-concierge/db';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Output DLP (MASTER-PLAN.md §1 "AI sandbox … output DLP"): scans
 * customer-facing text this system generates for PII patterns that should
 * never be there. Every reply this phase sends is built from Step 4's fixed
 * templates (clarificationPromptBuilder.ts) listing only field *names*
 * ("pickup date", …), never a customer's actual data — so this should never
 * fire today. It exists as a tripwire for the moment a future phase adds
 * real free-text AI generation to a customer-facing reply (MASTER-PLAN.md
 * §5's AI narration steps), so that path inherits a working guardrail on
 * day one instead of one bolted on after an incident. Never blocks the
 * send — a false positive (e.g. a phone-number-shaped booking reference)
 * breaking a legitimate reply would be worse than the leak this guards
 * against — only flags it for review.
 */
export async function flagUnexpectedPiiInOutboundText(
  deps: { prisma: PrismaClient; logger: FastifyBaseLogger },
  input: { tenantId: string; channel: string; text: string },
): Promise<void> {
  const classification = classifyPII(input.text);
  if (!classification.containsPii) return;

  deps.logger.warn(
    { channel: input.channel, categories: classification.categories },
    'DLP: outbound message contains unexpected PII-shaped content',
  );
  await withTenantContext(deps.prisma, input.tenantId, (tx) =>
    recordSecurityEvent(tx, {
      tenantId: input.tenantId,
      type: SecurityEventType.DLP_OUTBOUND_PII_DETECTED,
      severity: SecuritySeverity.WARNING,
      metadata: { channel: input.channel, categories: classification.categories },
    }),
  );
}
