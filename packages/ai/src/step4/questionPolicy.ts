import {
  FREE_TEXT_MISSING_INFO_FIELDS,
  OPTIONAL_MISSING_INFO_FIELDS,
  pendingQuestionSchema,
  type MissingInfoFieldKeyValue,
  type PendingQuestion,
} from '@ai-concierge/domain';
import { renderQuestionTemplate } from './fieldTemplates.js';

export interface SelectQuestionsInput {
  /** Required fields still missing this turn — always surfaced. */
  missingFields: MissingInfoFieldKeyValue[];
  /** Optional fields never yet answered — surfaced once, last. */
  unansweredOptionalFields: MissingInfoFieldKeyValue[];
  /** Every field key ever asked before — a field in here is never asked again. */
  askedFieldKeys: MissingInfoFieldKeyValue[];
  /**
   * The free-text field (address / special requests) currently occupying
   * the single free-text slot, if any — a second one is normally held back
   * until the first resolves, so a free-text reply is never ambiguous about
   * which field it answers.
   */
  pendingFreeTextField: MissingInfoFieldKeyValue | null;
  language: string;
}

export interface SelectQuestionsOutcome {
  newQuestions: PendingQuestion[];
  /**
   * Fields whose pending question was withdrawn to make room for a required
   * free-text field — never treated as "asked" (they stay eligible to be
   * asked again once the slot frees up), just deferred.
   */
  withdrawnFields: MissingInfoFieldKeyValue[];
}

/**
 * Deterministic decision-maker for *what to ask next*, distinct from
 * MissingFieldDetector's *what is missing*: a field can be missing for many
 * turns in a row without becoming a new question (it is already pending),
 * and an optional field is only ever offered once. Typed templates only —
 * nothing here is generated from customer text, so there is nothing that
 * could leak an internal prompt or instruction.
 */
export class QuestionPolicy {
  selectNewQuestions(input: SelectQuestionsInput, now: Date): SelectQuestionsOutcome {
    const askedSet = new Set(input.askedFieldKeys);
    const nowIso = now.toISOString();
    const newQuestions: PendingQuestion[] = [];
    const withdrawnFields: MissingInfoFieldKeyValue[] = [];
    let slotHolder = input.pendingFreeTextField;

    const tryAdd = (field: MissingInfoFieldKeyValue, required: boolean): void => {
      if (askedSet.has(field)) return;

      if (FREE_TEXT_MISSING_INFO_FIELDS.includes(field)) {
        if (slotHolder !== null && slotHolder !== field) {
          // A required field always outranks an optional one for the single free-text
          // slot — bump the optional occupant (deferred, not "asked") rather than let
          // it permanently block a field that only became required on a later turn.
          if (required && OPTIONAL_MISSING_INFO_FIELDS.includes(slotHolder)) {
            withdrawnFields.push(slotHolder);
          } else {
            return;
          }
        }
        slotHolder = field;
      }

      newQuestions.push(this.buildQuestion(field, required, input.language, nowIso));
    };

    for (const field of input.missingFields) tryAdd(field, true);
    for (const field of input.unansweredOptionalFields) tryAdd(field, false);

    return { newQuestions, withdrawnFields };
  }

  private buildQuestion(
    field: MissingInfoFieldKeyValue,
    required: boolean,
    language: string,
    askedAt: string,
  ): PendingQuestion {
    const rendered = renderQuestionTemplate(field, language);
    return pendingQuestionSchema.parse({
      field,
      questionId: rendered.questionId,
      text: rendered.text,
      language: rendered.language,
      required,
      askedAt,
    });
  }
}
