import { Prisma, type PrismaClient } from '@prisma/client';
import type { RecommendAlternativesResult, TenantId } from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

export interface CreateAlternativeRecommendationInput {
  tenantId: TenantId;
  messageId: string;
  result: RecommendAlternativesResult;
}

/** Same append-only-history convention as VehicleDetermination/AvailabilityCheck. */
export async function createAlternativeRecommendation(
  db: Executor,
  input: CreateAlternativeRecommendationInput,
) {
  const { result } = input;
  return db.alternativeRecommendation.create({
    data: {
      tenantId: input.tenantId,
      messageId: input.messageId,
      requestedVehicleId: result.requestedVehicleId,
      status: result.status,
      // Prisma.DbNull, not plain `null`, for "no row value" on a nullable Json column.
      primary: result.primary === null ? Prisma.DbNull : (result.primary as Prisma.InputJsonValue),
      secondary:
        result.secondary === null ? Prisma.DbNull : (result.secondary as Prisma.InputJsonValue),
      consideredCount: result.consideredCount,
      modelMetadata: result.modelMetadata,
    },
  });
}

/**
 * Tenant-scoped read — same isolation convention as the other repositories.
 * Orders by `createdAt` then `id` — `createdAt` alone is only millisecond
 * precision, so two runs for the same message in the same millisecond would
 * otherwise resolve non-deterministically (Postgres gives no tie-break
 * guarantee on its own). The `id` tiebreak only makes the query repeatable,
 * not truly chronological (ids are random UUIDs, not time-ordered) — the
 * same limitation every other `findLatest*` repository in this codebase
 * already has; see PHASE-7.md §9.
 */
export async function findLatestAlternativeRecommendationForMessage(
  db: Executor,
  tenantId: TenantId,
  messageId: string,
) {
  return db.alternativeRecommendation.findFirst({
    where: { tenantId, messageId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

/**
 * The most recent recommendation across every message of a conversation —
 * what lets the concierge tell "the customer is still looking at the
 * alternatives we already offered" apart from "the customer picked a
 * different car" (compare `requestedVehicleId` with the vehicle now resolved).
 */
export async function findLatestAlternativeRecommendationForConversation(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
) {
  return db.alternativeRecommendation.findFirst({
    where: { tenantId, message: { conversationId } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}
