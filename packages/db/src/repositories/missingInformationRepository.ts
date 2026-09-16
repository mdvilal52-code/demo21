import {
  Prisma,
  type PrismaClient,
  type MissingInformationState as PrismaState,
} from '@prisma/client';
import {
  AppError,
  conversationStateSchema,
  type ConversationStateData,
  type TenantId,
} from '@ai-concierge/domain';

type Executor = PrismaClient | Prisma.TransactionClient;

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Re-validates via Zod before it leaves this package — same read-boundary discipline as vehicleRepository. */
function toDomainState(row: PrismaState): ConversationStateData {
  return conversationStateSchema.parse({
    tenantId: row.tenantId,
    conversationId: row.conversationId,
    status: row.status,
    answers: row.answers,
    askedFieldKeys: row.askedFieldKeys,
    pendingQuestions: row.pendingQuestions,
    corrections: row.corrections,
    contradictions: row.contradictions,
    flags: row.flags,
    turnCount: row.turnCount,
    version: row.version,
    lastProcessedMessageId: row.lastProcessedMessageId,
  });
}

/** Tenant-scoped read — same isolation convention as the other repositories. */
export async function findMissingInformationState(
  db: Executor,
  tenantId: TenantId,
  conversationId: string,
): Promise<ConversationStateData | null> {
  const row = await db.missingInformationState.findFirst({ where: { tenantId, conversationId } });
  return row ? toDomainState(row) : null;
}

/**
 * First-turn insert. A concurrent first call for the same conversation loses
 * the unique-constraint race and gets a structured `CONFLICT` instead of a
 * raw driver error, same as `vehicleRepository.createVehicle`'s identity
 * constraint.
 */
export async function createMissingInformationState(
  db: Executor,
  state: ConversationStateData,
): Promise<ConversationStateData> {
  try {
    const row = await db.missingInformationState.create({
      data: {
        tenantId: state.tenantId,
        conversationId: state.conversationId,
        status: state.status,
        answers: state.answers as unknown as Prisma.InputJsonValue,
        askedFieldKeys: state.askedFieldKeys,
        pendingQuestions: state.pendingQuestions as unknown as Prisma.InputJsonValue,
        corrections: state.corrections as unknown as Prisma.InputJsonValue,
        contradictions: state.contradictions as unknown as Prisma.InputJsonValue,
        flags: state.flags,
        turnCount: state.turnCount,
        version: state.version,
        lastProcessedMessageId: state.lastProcessedMessageId,
      },
    });
    return toDomainState(row);
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new AppError(
        'CONFLICT',
        'Missing-information state already exists for this conversation; retry',
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Optimistic-version-checked update: the WHERE clause pins the row to the
 * version this write was computed from, so a concurrent turn for the same
 * conversation loses the race with a structured `CONFLICT` rather than
 * silently clobbering the other turn's answers.
 */
export async function updateMissingInformationState(
  db: Executor,
  state: ConversationStateData,
  expectedVersion: number,
): Promise<ConversationStateData> {
  const result = await db.missingInformationState.updateMany({
    where: {
      tenantId: state.tenantId,
      conversationId: state.conversationId,
      version: expectedVersion,
    },
    data: {
      status: state.status,
      answers: state.answers as unknown as Prisma.InputJsonValue,
      askedFieldKeys: state.askedFieldKeys,
      pendingQuestions: state.pendingQuestions as unknown as Prisma.InputJsonValue,
      corrections: state.corrections as unknown as Prisma.InputJsonValue,
      contradictions: state.contradictions as unknown as Prisma.InputJsonValue,
      flags: state.flags,
      turnCount: state.turnCount,
      lastProcessedMessageId: state.lastProcessedMessageId,
      version: { increment: 1 },
    },
  });

  if (result.count === 0) {
    throw new AppError(
      'CONFLICT',
      'Missing-information state was updated concurrently by another request; retry',
    );
  }

  const updated = await findMissingInformationState(db, state.tenantId, state.conversationId);
  if (!updated) {
    throw new AppError(
      'INTERNAL',
      'Missing-information state disappeared immediately after update',
    );
  }
  return updated;
}

/** Creates on the first turn, version-checked updates on every later turn. */
export async function saveMissingInformationState(
  db: Executor,
  state: ConversationStateData,
  priorVersion: number | null,
): Promise<ConversationStateData> {
  return priorVersion === null
    ? createMissingInformationState(db, state)
    : updateMissingInformationState(db, state, priorVersion);
}
