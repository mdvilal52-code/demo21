import {
  AnswerSource,
  MissingInfoStatus,
  contradictionRecordSchema,
  correctionRecordSchema,
  missingInfoAnswerSchema,
  type AnswerSourceValue,
  type ConversationStateData,
  type CorrectionRecord,
  type ContradictionRecord,
  type MissingInfoAnswer,
  type MissingInfoFieldKeyValue,
  type PendingQuestion,
  type TenantId,
} from '@ai-concierge/domain';
import type { ExtractedAnswerCandidate } from './answerExtractionService.js';

export interface ApplyCandidatesOutcome {
  next: ConversationState;
  /** Only this turn's new corrections — the state itself keeps the full history. */
  corrections: CorrectionRecord[];
  /** Only this turn's new contradictions (2+ different values for one field in one message). */
  contradictions: ContradictionRecord[];
}

/**
 * The persisted, mutable state for one conversation's Step 4 loop. Every
 * method returns a new instance (functional-core style) so merge logic stays
 * pure and unit-testable without a database; `packages/db`'s repository
 * layer is the only place `.data` is actually written/read. Every answer/
 * correction/contradiction is built through its Zod schema (never a bare
 * cast) so a bad candidate fails loudly here instead of persisting silently.
 */
export class ConversationState {
  private constructor(private readonly stateData: ConversationStateData) {}

  static createInitial(tenantId: TenantId, conversationId: string): ConversationState {
    return new ConversationState({
      tenantId,
      conversationId,
      status: MissingInfoStatus.AWAITING_CUSTOMER,
      answers: [],
      askedFieldKeys: [],
      pendingQuestions: [],
      corrections: [],
      contradictions: [],
      flags: { promptInjectionDetected: false, piiDetected: false },
      turnCount: 0,
      version: 0,
      lastProcessedMessageId: null,
    });
  }

  static fromData(data: ConversationStateData): ConversationState {
    return new ConversationState(data);
  }

  get data(): ConversationStateData {
    return this.stateData;
  }

  private withData(patch: Partial<ConversationStateData>): ConversationState {
    return new ConversationState({ ...this.stateData, ...patch });
  }

  /**
   * Merges this turn's extracted candidates into the answer set. A field
   * with two different candidate values in the *same* batch (i.e. the same
   * message) is a contradiction and is left untouched; a single value that
   * differs from an existing answer is a correction (the newest statement
   * wins); a single value that matches the existing answer is a no-op
   * (repeated answer) — idempotent by construction.
   */
  applyCandidates(
    candidates: ExtractedAnswerCandidate[],
    source: AnswerSourceValue,
    now: Date,
  ): ApplyCandidatesOutcome {
    const byField = new Map<string, ExtractedAnswerCandidate[]>();
    for (const candidate of candidates) {
      const existing = byField.get(candidate.field) ?? [];
      existing.push(candidate);
      byField.set(candidate.field, existing);
    }

    const answersByField = new Map<string, MissingInfoAnswer>(
      this.stateData.answers.map((answer) => [answer.field, answer]),
    );
    const newCorrections: CorrectionRecord[] = [];
    const newContradictions: ContradictionRecord[] = [];
    const nowIso = now.toISOString();

    for (const [field, fieldCandidates] of byField) {
      const distinctValues = [...new Set(fieldCandidates.map((c) => c.value))];

      if (distinctValues.length > 1) {
        newContradictions.push(
          contradictionRecordSchema.parse({
            field,
            candidates: distinctValues,
            message: `The message mentioned ${distinctValues.length} different values for ${field}`,
            detectedAt: nowIso,
          }),
        );
        continue;
      }

      const [value] = distinctValues;
      const existingAnswer = answersByField.get(field);

      if (!existingAnswer) {
        answersByField.set(
          field,
          missingInfoAnswerSchema.parse({
            field,
            value,
            source,
            answeredAt: nowIso,
            corrected: false,
          }),
        );
        continue;
      }

      if (existingAnswer.value === value) {
        continue; // repeated answer — already known, nothing to do
      }

      newCorrections.push(
        correctionRecordSchema.parse({
          field,
          previousValue: existingAnswer.value,
          newValue: value,
          detectedAt: nowIso,
        }),
      );
      answersByField.set(
        field,
        missingInfoAnswerSchema.parse({
          field,
          value,
          source,
          answeredAt: nowIso,
          corrected: true,
        }),
      );
    }

    const next = this.withData({
      answers: [...answersByField.values()],
      corrections: [...this.stateData.corrections, ...newCorrections],
      contradictions: [...this.stateData.contradictions, ...newContradictions],
    });

    return { next, corrections: newCorrections, contradictions: newContradictions };
  }

  /** Seeds an answer from Step 1 — never overwrites a value already present (e.g. a correction). */
  seedFromStep1(
    field: MissingInfoAnswer['field'],
    value: MissingInfoAnswer['value'],
    now: Date,
  ): ConversationState {
    if (this.stateData.answers.some((answer) => answer.field === field)) {
      return this;
    }
    return this.withData({
      answers: [
        ...this.stateData.answers,
        missingInfoAnswerSchema.parse({
          field,
          value,
          source: AnswerSource.STEP1_INTENT,
          answeredAt: now.toISOString(),
          corrected: false,
        }),
      ],
    });
  }

  /** Drops any pending question whose field now has an answer — it is resolved, not "asked again". */
  dropAnsweredQuestions(): ConversationState {
    const answeredFields = new Set(this.stateData.answers.map((answer) => answer.field));
    return this.withData({
      pendingQuestions: this.stateData.pendingQuestions.filter(
        (question) => !answeredFields.has(question.field),
      ),
    });
  }

  /**
   * Removes a pending question without marking it "asked" — used when a
   * required free-text field needs the single free-text slot an optional
   * question is currently holding. Unlike `dropAnsweredQuestions`, the
   * field stays eligible to be asked again later (it was deferred, not
   * resolved), so it is cleared from `askedFieldKeys` too.
   */
  withdrawPendingQuestions(fields: MissingInfoFieldKeyValue[]): ConversationState {
    if (fields.length === 0) return this;
    const fieldSet = new Set(fields);
    return this.withData({
      pendingQuestions: this.stateData.pendingQuestions.filter(
        (question) => !fieldSet.has(question.field),
      ),
      askedFieldKeys: this.stateData.askedFieldKeys.filter((field) => !fieldSet.has(field)),
    });
  }

  /** Adds newly-surfaced questions and permanently marks their fields as asked (never re-asked). */
  addPendingQuestions(questions: PendingQuestion[]): ConversationState {
    if (questions.length === 0) return this;
    return this.withData({
      pendingQuestions: [...this.stateData.pendingQuestions, ...questions],
      askedFieldKeys: [
        ...new Set([...this.stateData.askedFieldKeys, ...questions.map((q) => q.field)]),
      ],
    });
  }

  withStatus(status: ConversationStateData['status']): ConversationState {
    return this.withData({ status });
  }

  withFlags(flags: ConversationStateData['flags']): ConversationState {
    return this.withData({
      flags: {
        promptInjectionDetected:
          this.stateData.flags.promptInjectionDetected || flags.promptInjectionDetected,
        piiDetected: this.stateData.flags.piiDetected || flags.piiDetected,
      },
    });
  }

  incrementTurn(): ConversationState {
    return this.withData({ turnCount: this.stateData.turnCount + 1 });
  }

  withLastProcessedMessageId(messageId: string): ConversationState {
    return this.withData({ lastProcessedMessageId: messageId });
  }
}
