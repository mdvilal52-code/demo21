import { z } from 'zod';

/** The customer's underlying need, as recognized from a single message. */
export const IntentType = {
  ENQUIRY: 'ENQUIRY',
  BOOKING_REQUEST: 'BOOKING_REQUEST',
  AVAILABILITY_REQUEST: 'AVAILABILITY_REQUEST',
  PRICE_REQUEST: 'PRICE_REQUEST',
  DOCUMENT_REQUEST: 'DOCUMENT_REQUEST',
  PAYMENT_REQUEST: 'PAYMENT_REQUEST',
  SUPPORT_REQUEST: 'SUPPORT_REQUEST',
  RETURN_REQUEST: 'RETURN_REQUEST',
  COMPLAINT: 'COMPLAINT',
  UNKNOWN: 'UNKNOWN',
} as const;

export const intentTypeSchema = z.enum([
  IntentType.ENQUIRY,
  IntentType.BOOKING_REQUEST,
  IntentType.AVAILABILITY_REQUEST,
  IntentType.PRICE_REQUEST,
  IntentType.DOCUMENT_REQUEST,
  IntentType.PAYMENT_REQUEST,
  IntentType.SUPPORT_REQUEST,
  IntentType.RETURN_REQUEST,
  IntentType.COMPLAINT,
  IntentType.UNKNOWN,
]);
export type IntentTypeValue = z.infer<typeof intentTypeSchema>;

export const IntentStatus = {
  RECOGNIZED: 'RECOGNIZED',
  NEEDS_CLARIFICATION: 'NEEDS_CLARIFICATION',
} as const;
export const intentStatusSchema = z.enum([
  IntentStatus.RECOGNIZED,
  IntentStatus.NEEDS_CLARIFICATION,
]);

export const Urgency = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' } as const;
export const urgencySchema = z.enum([Urgency.LOW, Urgency.MEDIUM, Urgency.HIGH]);

/**
 * Extracted entities. Every field is optional/nullable — a field the engine
 * did not find with real evidence in the message MUST be omitted rather
 * than guessed. `missingFields` on IntentResult lists what a complete
 * booking-shaped request would still need.
 */
export const extractedEntitiesSchema = z.object({
  vehicleIntent: z.string().min(1).max(200).optional(),
  pickupDate: z.string().datetime().optional(),
  returnDate: z.string().datetime().optional(),
  location: z.string().min(1).max(200).optional(),
  passengerCount: z.number().int().positive().max(64).optional(),
  driverRequired: z.boolean().optional(),
  language: z.string().min(2).max(10),
  urgency: urgencySchema,
});
export type ExtractedEntities = z.infer<typeof extractedEntitiesSchema>;

export const intentFlagsSchema = z.object({
  promptInjectionDetected: z.boolean(),
});

export const modelMetadataSchema = z.object({
  engine: z.string().min(1),
  version: z.string().min(1),
  deterministic: z.boolean(),
});

export const CONFIDENCE_THRESHOLD = 0.55;

export const intentResultSchema = z.object({
  intentType: intentTypeSchema,
  status: intentStatusSchema,
  confidence: z.number().min(0).max(1),
  entities: extractedEntitiesSchema,
  missingFields: z.array(z.string()),
  clarificationPrompt: z.string().min(1).max(500).optional(),
  flags: intentFlagsSchema,
  modelMetadata: modelMetadataSchema,
});
export type IntentResult = z.infer<typeof intentResultSchema>;

/** Fields a BOOKING_REQUEST needs to move forward; drives clarification prompts. */
export const BOOKING_REQUIRED_FIELDS = [
  'vehicleIntent',
  'pickupDate',
  'returnDate',
  'location',
] as const;
