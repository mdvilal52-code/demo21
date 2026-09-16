import { MissingInfoFieldKey, type MissingInfoFieldKeyValue } from '@ai-concierge/domain';

/**
 * Typed question templates — English + Arabic, matching MASTER-PLAN.md's
 * locked language decision (#4: English first, Arabic/RTL supported). Every
 * template is fixed, versioned text; nothing here is ever generated from a
 * customer message, so there is no internal prompt or instruction that could
 * leak through a rendered question.
 */
export const SUPPORTED_QUESTION_LANGUAGES = ['en', 'ar'] as const;
export type SupportedQuestionLanguage = (typeof SUPPORTED_QUESTION_LANGUAGES)[number];

interface QuestionTemplate {
  questionId: string;
  text: Record<SupportedQuestionLanguage, string>;
}

const QUESTION_TEMPLATES: Record<MissingInfoFieldKeyValue, QuestionTemplate> = {
  [MissingInfoFieldKey.FLIGHT_NUMBER]: {
    questionId: 'ask.flightNumber.v1',
    text: {
      en: 'Could you share your flight number so we can arrange airport pickup?',
      ar: 'هل يمكنك مشاركة رقم رحلتك حتى نتمكن من ترتيب الاستلام من المطار؟',
    },
  },
  [MissingInfoFieldKey.DROPOFF_ADDRESS]: {
    questionId: 'ask.dropoffAddress.v1',
    text: {
      en: 'What is the exact hotel name or address for drop-off?',
      ar: 'ما هو اسم الفندق أو العنوان الدقيق للتوصيل؟',
    },
  },
  [MissingInfoFieldKey.PICKUP_TIME]: {
    questionId: 'ask.pickupTime.v1',
    text: {
      en: 'What time would you like the vehicle ready for pickup?',
      ar: 'في أي وقت تريد أن تكون المركبة جاهزة للاستلام؟',
    },
  },
  [MissingInfoFieldKey.DRIVER_REQUIREMENT]: {
    questionId: 'ask.driverRequirement.v1',
    text: {
      en: 'Would you like a driver included, or will you be self-driving?',
      ar: 'هل تريد سائقًا مرفقًا أم ستقود بنفسك؟',
    },
  },
  [MissingInfoFieldKey.SPECIAL_REQUESTS]: {
    questionId: 'ask.specialRequests.v1',
    text: {
      en: 'Any special requests for your rental (e.g. child seat, extra luggage space)?',
      ar: 'هل لديك أي طلبات خاصة لتأجيرك (مثل مقعد أطفال أو مساحة أمتعة إضافية)؟',
    },
  },
  [MissingInfoFieldKey.CONTACT_DETAILS]: {
    questionId: 'ask.contactDetails.v1',
    text: {
      en: 'Could you share a phone number or email so we can reach you about your booking?',
      ar: 'هل يمكنك مشاركة رقم هاتف أو بريد إلكتروني حتى نتمكن من التواصل معك بخصوص حجزك؟',
    },
  },
};

const DEFAULT_LANGUAGE: SupportedQuestionLanguage = 'en';

function resolveLanguage(language: string): SupportedQuestionLanguage {
  const normalized = language.toLowerCase();
  return (SUPPORTED_QUESTION_LANGUAGES as readonly string[]).includes(normalized)
    ? (normalized as SupportedQuestionLanguage)
    : DEFAULT_LANGUAGE;
}

export interface RenderedQuestion {
  questionId: string;
  text: string;
  language: SupportedQuestionLanguage;
}

/** Falls back to English for any language Step 1 detects but Step 4 has no template for. */
export function renderQuestionTemplate(
  field: MissingInfoFieldKeyValue,
  language: string,
): RenderedQuestion {
  const template = QUESTION_TEMPLATES[field];
  const resolvedLanguage = resolveLanguage(language);
  return {
    questionId: template.questionId,
    text: template.text[resolvedLanguage],
    language: resolvedLanguage,
  };
}
