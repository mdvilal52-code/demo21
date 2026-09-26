import {
  extractEligibilityIntake,
  extractIntakeWithAI,
  stripQuotedReply,
  type AIProvider,
} from '@ai-concierge/ai';
import {
  findEligibilityIntake,
  findMessagesForConversation,
  markEligibilityIntakeAsked,
  upsertEligibilityIntake,
  type EligibilityIntakePatch,
  type PrismaClient,
} from '@ai-concierge/db';
import {
  createEmptyEligibilityIntake,
  findMissingEligibilityFields,
  isAppError,
  toEligibilityCustomerInput,
  type EligibilityCustomerInput,
  type EligibilityIntake,
  type EligibilityIntakeFieldValue,
  type TenantId,
} from '@ai-concierge/domain';
import { decryptField, encryptField } from '@ai-concierge/security';
import type { ReplyServiceLogger } from './conversationalReplyService.js';

export interface EligibilityIntakeDeps {
  prisma: PrismaClient;
  aiProvider: AIProvider;
  /** AES-256 key (base64) the date of birth is encrypted with at rest. */
  piiKey: string;
  logger: ReplyServiceLogger;
}

export interface CollectEligibilityIntakeInput {
  tenantId: TenantId;
  conversationId: string;
  now?: Date;
}

export interface EligibilityIntakeResult {
  intake: EligibilityIntake;
  missing: EligibilityIntakeFieldValue[];
  complete: boolean;
  /** The exact body Step 5 accepts; `null` until `complete`. */
  customerInput: EligibilityCustomerInput | null;
  /** The customer wrote a date of birth we could not read unambiguously (e.g. 03/04/1990). */
  dateOfBirthAmbiguous: boolean;
  /** The concierge had already asked for these details before this call. */
  askedBefore: boolean;
  /** The LLM extractor contributed at least one field. */
  usedAi: boolean;
}

/** A reply this short cannot carry any of the five facts; skip the paid model call. */
const MIN_CHARS_FOR_AI_EXTRACTION = 3;

function mergeDefined(target: EligibilityIntake, patch: Partial<EligibilityIntake>): void {
  for (const [key, value] of Object.entries(patch) as Array<
    [keyof EligibilityIntake, EligibilityIntake[keyof EligibilityIntake] | undefined]
  >) {
    if (value !== undefined && value !== null) {
      (target as unknown as Record<string, unknown>)[key] = value;
    }
  }
}

function toPersistedPatch(
  before: EligibilityIntake,
  after: EligibilityIntake,
  piiKey: string,
): EligibilityIntakePatch {
  const patch: EligibilityIntakePatch = {};
  if (after.dateOfBirth !== before.dateOfBirth && after.dateOfBirth !== null) {
    patch.dateOfBirthEnc = encryptField(after.dateOfBirth, piiKey);
  }
  if (after.nationality !== before.nationality) patch.nationality = after.nationality;
  if (after.licenseType !== before.licenseType) patch.licenseType = after.licenseType;
  if (after.hasValidLicense !== before.hasValidLicense) {
    patch.hasValidLicense = after.hasValidLicense;
  }
  if (after.passportProvided !== before.passportProvided) {
    patch.passportProvided = after.passportProvided;
  }
  return patch;
}

/**
 * Reads what the customer has told the concierge about themselves as a
 * driver, merges it with what an earlier message already established, and
 * persists the result (date of birth encrypted). This is the bridge that
 * lets Step 5 run automatically: Step 5 itself only ever accepts a complete,
 * validated record (`toEligibilityCustomerInput`), so anything ambiguous or
 * missing here simply means "ask the customer", never a guess.
 *
 * The first time it runs for a conversation it reads every customer message
 * (a driver often volunteers their details while still choosing the car);
 * afterwards only the latest, since earlier ones were already merged in.
 * Deterministic extraction always runs; the Gemini extractor is consulted
 * only for facts it left unresolved, and only ever fills a *missing* field.
 */
export async function collectEligibilityIntake(
  deps: EligibilityIntakeDeps,
  input: CollectEligibilityIntakeInput,
): Promise<EligibilityIntakeResult> {
  const now = input.now ?? new Date();
  const stored = await findEligibilityIntake(deps.prisma, input.tenantId, input.conversationId);

  const before: EligibilityIntake = createEmptyEligibilityIntake();
  if (stored) {
    before.nationality = stored.nationality;
    before.licenseType = stored.licenseType as EligibilityIntake['licenseType'];
    before.hasValidLicense = stored.hasValidLicense;
    before.passportProvided = stored.passportProvided;
    if (stored.dateOfBirthEnc) {
      try {
        before.dateOfBirth = decryptField(stored.dateOfBirthEnc, deps.piiKey);
      } catch (error) {
        // A ciphertext we cannot open (rotated key, corruption) is treated as
        // "not collected" so the customer is simply asked again.
        deps.logger.error(
          { err: error },
          'eligibility intake: date of birth could not be decrypted',
        );
      }
    }
  }
  const askedBefore = stored?.askedAt != null;

  const messages = await findMessagesForConversation(
    deps.prisma,
    input.tenantId,
    input.conversationId,
  );
  const texts = (stored ? messages.slice(-1) : messages).map((message) => ({
    ...message,
    content: stripQuotedReply(message.content),
  }));

  const working: EligibilityIntake = { ...before };
  let dateOfBirthAmbiguous = false;
  for (const message of texts) {
    const extraction = extractEligibilityIntake({
      text: message.content,
      asked: askedBefore,
      missing: findMissingEligibilityFields(working),
      now,
    });
    mergeDefined(working, extraction.patch);
    // Only the customer's latest message decides whether we still need to ask
    // them to rewrite an ambiguous date.
    if (message === texts[texts.length - 1]) {
      dateOfBirthAmbiguous = extraction.dateOfBirthAmbiguous;
    }
  }

  const latest = texts[texts.length - 1];
  let usedAi = false;
  const stillMissing = findMissingEligibilityFields(working);
  if (
    stillMissing.length > 0 &&
    latest &&
    latest.content.trim().length >= MIN_CHARS_FOR_AI_EXTRACTION
  ) {
    try {
      const ai = await extractIntakeWithAI(deps.aiProvider, {
        text: latest.content,
        missing: stillMissing,
        now,
      });
      if (Object.keys(ai.patch).length > 0) {
        mergeDefined(working, ai.patch);
        usedAi = true;
        if (ai.patch.dateOfBirth) dateOfBirthAmbiguous = false;
      }
    } catch (error) {
      if (!(isAppError(error) && error.code === 'NOT_CONFIGURED')) {
        deps.logger.warn(
          { err: error },
          'eligibility intake: AI extraction failed, continuing deterministically',
        );
      }
    }
  }

  const patch = toPersistedPatch(before, working, deps.piiKey);
  if (Object.keys(patch).length > 0) {
    await upsertEligibilityIntake(deps.prisma, input.tenantId, input.conversationId, patch);
  }

  const missing = findMissingEligibilityFields(working);
  return {
    intake: working,
    missing,
    complete: missing.length === 0,
    customerInput: missing.length === 0 ? toEligibilityCustomerInput(working) : null,
    dateOfBirthAmbiguous,
    askedBefore,
    usedAi,
  };
}

/** Called once the concierge has actually asked; lets a later bare "Indian" or "yes" count as an answer. */
export async function markIntakeRequested(
  deps: Pick<EligibilityIntakeDeps, 'prisma'>,
  input: { tenantId: TenantId; conversationId: string; now?: Date },
): Promise<void> {
  await markEligibilityIntakeAsked(
    deps.prisma,
    input.tenantId,
    input.conversationId,
    input.now ?? new Date(),
  );
}
