import { IntentType, type IntentTypeValue } from '@ai-concierge/domain';

/**
 * Deterministic keyword lexicon backing the Phase 1 rule-based intent
 * engine. Every list is intentionally small and explicit — a keyword not in
 * here simply isn't matched, which is the desired behavior (no guessing).
 */
export const INTENT_KEYWORDS: Record<Exclude<IntentTypeValue, 'UNKNOWN'>, string[]> = {
  [IntentType.BOOKING_REQUEST]: [
    'book',
    'booking',
    'rent',
    'rental',
    'reserve',
    'reservation',
    'hire',
    'i need a car',
    'i want a car',
  ],
  [IntentType.AVAILABILITY_REQUEST]: [
    'available',
    'availability',
    'do you have',
    'is there a',
    'in stock',
    'free on',
  ],
  [IntentType.PRICE_REQUEST]: [
    'price',
    'pricing',
    'cost',
    'how much',
    'rate',
    'rates',
    'quote',
    'quotation',
    'fee',
  ],
  [IntentType.DOCUMENT_REQUEST]: [
    'document',
    'documents',
    'passport',
    'driving license',
    'driving licence',
    'emirates id',
    'visa copy',
    'what documents',
    'id required',
  ],
  [IntentType.PAYMENT_REQUEST]: [
    'pay',
    'payment',
    'invoice',
    'deposit',
    'refund my',
    'transfer',
    'pay online',
    'payment link',
  ],
  [IntentType.SUPPORT_REQUEST]: [
    'help',
    'issue',
    'problem',
    'not working',
    'support',
    'stuck',
    'trouble',
    'assist me',
  ],
  [IntentType.RETURN_REQUEST]: [
    'return the car',
    'returning the car',
    'drop off',
    'drop-off',
    'give back',
    'bring back the car',
  ],
  [IntentType.COMPLAINT]: [
    'complaint',
    'unhappy',
    'disappointed',
    'terrible',
    'worst',
    'bad experience',
    'angry',
    'scam',
    'rude',
    'awful',
    'unacceptable',
  ],
  [IntentType.ENQUIRY]: [
    'interested in',
    'enquiry',
    'inquiry',
    'looking for a car',
    'tell me about',
    'information about',
  ],
};

export const VEHICLE_KEYWORDS: string[] = [
  'lamborghini',
  'urus',
  'rolls-royce',
  'rolls royce',
  'cullinan',
  'g63',
  'g-wagon',
  'g wagon',
  'ferrari',
  'bentley',
  'range rover',
  'suv',
  'sedan',
  'sports car',
  'luxury car',
  'van',
  'seven seater',
  '7-seater',
];

export const LOCATION_KEYWORDS: string[] = [
  'dubai marina',
  'downtown dubai',
  'business bay',
  'jbr',
  'palm jumeirah',
  'dubai airport',
  'dxb',
  'abu dhabi',
  'sharjah',
  'dubai',
];

export const DRIVER_REQUIRED_KEYWORDS = [
  'with driver',
  'with a driver',
  'chauffeur',
  'need a driver',
];
export const SELF_DRIVE_KEYWORDS = ['self drive', 'self-drive', 'without driver', 'no driver'];

export const HIGH_URGENCY_KEYWORDS = [
  'urgent',
  'asap',
  'immediately',
  'right now',
  'emergency',
  'as soon as possible',
];
export const MEDIUM_URGENCY_KEYWORDS = ['soon', 'this week', 'today', 'tonight'];
