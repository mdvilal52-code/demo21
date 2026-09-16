import {
  FREE_TEXT_MISSING_INFO_FIELDS,
  MissingInfoFieldKey,
  MissingInfoStatus,
  classifyPII,
  missingInformationResultSchema,
  type ChannelValue,
  type ConversationStateData,
  type MissingInformationResult,
  type NormalizedLocation,
  type TenantId,
} from '@ai-concierge/domain';
import { sanitizeForProcessing } from '../sanitize.js';
import {
  AnswerExtractionService,
  type ExtractedAnswerCandidate,
} from './answerExtractionService.js';
import { ConversationState } from './conversationState.js';
import { MissingFieldDetector } from './missingFieldDetector.js';
import type { FieldRequirementContext } from './fieldRequirementRules.js';
import { QuestionPolicy } from './questionPolicy.js';

export interface MissingInformationTurnInput extends MissingInformationStepContext {
  tenantId: TenantId;
  conversationId: string;
  /** Id of the message processed this turn — lets the caller detect a retried/duplicate request. */
  messageId: string;
  /** The conversation's latest message — never re-parsed raw text at a later layer. */
  latestMessageText: string;
  /** null on the very first Step 4 call for this conversation. */
  priorState: ConversationStateData | null;
  referenceDate?: Date;
}

export interface MissingInformationTurnOutcome {
  result: MissingInformationResult;
  nextStateData: ConversationStateData;
}

export interface MissingInformationStepContext {
  step1: { driverRequired?: boolean; language: string };
  step2: { pickupLocation: NormalizedLocation | null; dropoffLocation: NormalizedLocation | null };
  channel: ChannelValue;
}

const MODEL_METADATA = {
  engine: 'missing-information-engine-v1',
  version: '0.1.0',
  deterministic: true,
} as const;

/**
 * Step 4 — Ask Missing Information. Wires AnswerExtractionService (AI
 * proposes) to MissingFieldDetector + QuestionPolicy (deterministic domain
 * logic decides what's missing and what to ask), same "AI proposes,
 * deterministic domain logic verifies" split as Steps 1-3 — with
 * ConversationState as the piece those steps never needed: this is the
 * first genuinely stateful, multi-turn journey step. Never throws; the
 * abuse-protection turn cap is enforced by the caller *before* invoking
 * this (see apps/api's missingInformationService), matching how Steps 1-3's
 * orchestrators never throw AppError themselves.
 */
export class MissingInformationEngine {
  private readonly extractionService = new AnswerExtractionService();
  private readonly detector = new MissingFieldDetector();
  private readonly questionPolicy = new QuestionPolicy();

  processTurn(input: MissingInformationTurnInput): MissingInformationTurnOutcome {
    const referenceDate = input.referenceDate ?? new Date();
    const isFirstTurn = input.priorState === null;
    const { promptInjectionDetected, sanitizedText } = sanitizeForProcessing(
      input.latestMessageText,
    );

    let state = input.priorState
      ? ConversationState.fromData(input.priorState)
      : ConversationState.createInitial(input.tenantId, input.conversationId);

    if (isFirstTurn && input.step1.driverRequired !== undefined) {
      state = state.seedFromStep1(
        MissingInfoFieldKey.DRIVER_REQUIREMENT,
        input.step1.driverRequired,
        referenceDate,
      );
    }

    const requirementContext = this.buildRequirementContext(input);

    const candidates = this.extractCandidates(state, sanitizedText);

    const {
      next: mergedState,
      corrections,
      contradictions,
    } = state.applyCandidates(candidates, 'CUSTOMER_REPLY', referenceDate);
    state = mergedState.dropAnsweredQuestions();

    const detection = this.detector.detect({
      context: requirementContext,
      answers: state.data.answers,
    });

    const pendingFreeTextField =
      state.data.pendingQuestions.find((question) =>
        FREE_TEXT_MISSING_INFO_FIELDS.includes(question.field),
      )?.field ?? null;
    const { newQuestions, withdrawnFields } = this.questionPolicy.selectNewQuestions(
      {
        missingFields: detection.missingFields,
        unansweredOptionalFields: detection.unansweredOptionalFields,
        askedFieldKeys: state.data.askedFieldKeys,
        pendingFreeTextField,
        language: input.step1.language,
      },
      referenceDate,
    );
    state = state.withdrawPendingQuestions(withdrawnFields).addPendingQuestions(newQuestions);

    const piiDetected = classifyPII(sanitizedText).containsPii;
    const flags = { promptInjectionDetected, piiDetected };
    state = state.withFlags(flags);

    const status =
      detection.missingFields.length === 0
        ? MissingInfoStatus.COMPLETE
        : MissingInfoStatus.AWAITING_CUSTOMER;
    state = state.withStatus(status).incrementTurn().withLastProcessedMessageId(input.messageId);

    const result = missingInformationResultSchema.parse({
      status,
      missingFields: detection.missingFields,
      pendingQuestions: state.data.pendingQuestions,
      answers: state.data.answers,
      corrections,
      contradictions,
      flags,
      modelMetadata: MODEL_METADATA,
    });

    return { result, nextStateData: state.data };
  }

  /**
   * Reconstructs the *current* result from already-persisted state alone —
   * no extraction, no merging, no mutation. For replaying a retried request
   * against an unchanged message: calling `processTurn` again would
   * re-run extraction with the *updated* pendingQuestions as context and
   * could misread the original message as a reply to a question that same
   * message only just caused to be asked. Reconstructing instead of
   * reprocessing sidesteps that entirely. `missingFields` is recomputed
   * (cheap and pure) so it always reflects the latest Step 1-3 data; nothing
   * else about `state` changes, so `corrections`/`contradictions` are empty
   * — nothing new happened.
   */
  buildResultFromState(
    state: ConversationStateData,
    context: MissingInformationStepContext,
  ): MissingInformationResult {
    const detection = this.detector.detect({
      context: this.buildRequirementContext(context),
      answers: state.answers,
    });

    return missingInformationResultSchema.parse({
      status: state.status,
      missingFields: detection.missingFields,
      pendingQuestions: state.pendingQuestions,
      answers: state.answers,
      corrections: [],
      contradictions: [],
      flags: state.flags,
      modelMetadata: MODEL_METADATA,
    });
  }

  private buildRequirementContext(context: MissingInformationStepContext): FieldRequirementContext {
    return {
      pickupLocation: context.step2.pickupLocation,
      dropoffLocation: context.step2.dropoffLocation,
      channel: context.channel,
      driverRequirementKnownFromStep1: context.step1.driverRequired !== undefined,
    };
  }

  /**
   * Structured fields (flight number, time, driver requirement, contact) are
   * scanned unconditionally — they have real patterns and never guess. Free
   * text (address / special requests) can't be pattern-matched safely, so it
   * is only ever captured when exactly one such field is already an
   * outstanding *pending* question (i.e. this message is unambiguously a
   * reply to a question asked in an earlier turn) — never opportunistically
   * on a first message, which would risk mistaking an unrelated sentence for
   * an answer nobody actually gave.
   */
  private extractCandidates(
    state: ConversationState,
    sanitizedText: string,
  ): ExtractedAnswerCandidate[] {
    const candidates = this.extractionService.extractStructuredCandidates(sanitizedText);

    const pendingFreeTextFields = state.data.pendingQuestions
      .map((question) => question.field)
      .filter((field) => FREE_TEXT_MISSING_INFO_FIELDS.includes(field));

    if (pendingFreeTextFields.length === 1) {
      const field = pendingFreeTextFields[0] as
        typeof MissingInfoFieldKey.DROPOFF_ADDRESS | typeof MissingInfoFieldKey.SPECIAL_REQUESTS;
      // If the message already yielded other structured answers, it was clearly about those
      // fields — only fall back to treating the whole message as free text when it wasn't.
      const freeTextCandidate = this.extractionService.extractFreeTextAnswer(field, sanitizedText, {
        allowUnanchoredCapture: candidates.length === 0,
      });
      if (freeTextCandidate) {
        candidates.push(freeTextCandidate);
      }
    }

    return candidates;
  }
}
