import type { TranscriptMessage, TranscriptResponse } from '@ai-concierge/contracts';
import {
  findConversationById,
  findEligibilityIntake,
  findLatestEligibilityDecisionForConversation,
  findLatestQuoteForConversation,
  findMessagesForConversation,
  findOutboundMessagesForConversation,
  toDomainQuoteSnapshot,
  type PrismaClient,
} from '@ai-concierge/db';
import { AppError, type TenantId } from '@ai-concierge/domain';

export interface TranscriptServiceDeps {
  prisma: PrismaClient;
}

/** Upper bound on outbound turns read for one conversation; a chat this long is already an outlier. */
const MAX_OUTBOUND_TURNS = 300;

/**
 * A conversation as staff read it — the human worker's view. Merges what the
 * customer wrote (`Message`) with what the concierge and staff wrote back
 * (`OutboundMessage`) into one chronological thread, and attaches the facts a
 * person needs to answer well: the eligibility outcome, the current quote and
 * which driver details the customer has given.
 *
 * The date of birth is PII and deliberately never leaves this function — only
 * the fact that one was provided.
 */
export async function getTranscript(
  deps: TranscriptServiceDeps,
  input: { tenantId: TenantId; conversationId: string },
): Promise<TranscriptResponse> {
  const conversation = await findConversationById(
    deps.prisma,
    input.tenantId,
    input.conversationId,
  );
  if (!conversation) {
    throw new AppError('NOT_FOUND', 'Conversation not found');
  }

  const [customerMessages, outbound, eligibility, quoteRow, intake] = await Promise.all([
    findMessagesForConversation(deps.prisma, input.tenantId, input.conversationId),
    findOutboundMessagesForConversation(
      deps.prisma,
      input.tenantId,
      input.conversationId,
      MAX_OUTBOUND_TURNS,
    ),
    findLatestEligibilityDecisionForConversation(deps.prisma, input.tenantId, input.conversationId),
    findLatestQuoteForConversation(deps.prisma, input.tenantId, input.conversationId),
    findEligibilityIntake(deps.prisma, input.tenantId, input.conversationId),
  ]);

  const messages: TranscriptMessage[] = [
    ...customerMessages.map((row): TranscriptMessage => ({
      id: row.id,
      role: 'CUSTOMER',
      content: row.content,
      source: null,
      stage: null,
      authorUserId: null,
      createdAt: row.createdAt.toISOString(),
    })),
    ...outbound.map((row): TranscriptMessage => ({
      id: row.id,
      role: row.source === 'HUMAN' ? 'STAFF' : 'CONCIERGE',
      content: row.content,
      source: row.source,
      stage: row.stage,
      authorUserId: row.authorUserId,
      createdAt: row.createdAt.toISOString(),
    })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    conversation: {
      id: conversation.id,
      channel: conversation.channel,
      customerRef: conversation.customerRef,
      createdAt: conversation.createdAt.toISOString(),
    },
    messages,
    eligibility: eligibility
      ? {
          status: eligibility.status,
          reason: eligibility.reason,
          decidedAt: eligibility.createdAt.toISOString(),
        }
      : null,
    quote: quoteRow ? toDomainQuoteSnapshot(quoteRow) : null,
    driverDetails: intake
      ? {
          nationality: intake.nationality,
          licenseType: intake.licenseType,
          hasValidLicense: intake.hasValidLicense,
          passportProvided: intake.passportProvided,
          dateOfBirthProvided: intake.dateOfBirthEnc !== null,
        }
      : null,
  };
}
