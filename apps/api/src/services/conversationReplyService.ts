import { createHash } from 'node:crypto';
import {
  appendMessageToConversation,
  findIdempotencyKey,
  saveIdempotencyKey,
  PrismaAuditWriter,
  type PrismaClient,
} from '@ai-concierge/db';
import { AppError, type TenantId } from '@ai-concierge/domain';
import type { PostConversationReplyResponse } from '@ai-concierge/contracts';

export interface ConversationReplyServiceDeps {
  prisma: PrismaClient;
}

export interface PostConversationReplyInput {
  tenantId: TenantId;
  conversationId: string;
  message: string;
  requestId: string;
  idempotencyKey?: string;
}

function hashRequest(input: PostConversationReplyInput): string {
  return createHash('sha256')
    .update(JSON.stringify({ conversationId: input.conversationId, message: input.message }))
    .digest('hex');
}

/**
 * Appends a follow-up customer message to an existing conversation — the
 * minimal capability Step 4's multi-turn loop needs to receive a reply at
 * all (see conversationReply.ts contracts). Never interprets the message;
 * that is entirely Step 4's (missingInformationService's) job. Supports the
 * same `Idempotency-Key` convention as `POST /v1/enquiries` — a retried
 * submission must never append the same reply twice.
 */
export async function postConversationReply(
  deps: ConversationReplyServiceDeps,
  input: PostConversationReplyInput,
): Promise<PostConversationReplyResponse> {
  if (input.idempotencyKey) {
    const existing = await findIdempotencyKey(deps.prisma, input.idempotencyKey);
    if (existing) {
      return existing.responseBody as PostConversationReplyResponse;
    }
  }

  return deps.prisma.$transaction(async (tx) => {
    const message = await appendMessageToConversation(
      tx,
      input.tenantId,
      input.conversationId,
      input.message,
    );
    if (!message) {
      throw new AppError('NOT_FOUND', 'Conversation not found');
    }

    const auditWriter = new PrismaAuditWriter(tx);
    await auditWriter.record({
      tenantId: input.tenantId,
      actor: 'customer:reply',
      action: 'conversation.message_appended',
      entityType: 'Conversation',
      entityId: input.conversationId,
      // Never the raw message content — that may carry PII; a reference is enough for the audit trail.
      after: { messageId: message.id },
      requestId: input.requestId,
    });

    const result: PostConversationReplyResponse = {
      conversationId: input.conversationId,
      messageId: message.id,
    };

    if (input.idempotencyKey) {
      try {
        await saveIdempotencyKey(tx, {
          key: input.idempotencyKey,
          tenantId: input.tenantId,
          requestHash: hashRequest(input),
          responseStatus: 201,
          responseBody: result,
        });
      } catch {
        // A concurrent request already won the race to store this key; the
        // response we're about to return is still correct for this attempt.
      }
    }

    return result;
  });
}
