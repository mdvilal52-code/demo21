import { z } from 'zod';
import {
  channelSchema,
  journeyStateSchema,
  moneySchema,
  quoteSnapshotSchema,
} from '@ai-concierge/domain';

/**
 * Admin dashboard — Home (docs/MASTER-PLAN.md Phase 7: "JourneyStepper with
 * live counts, StatTiles: Active Bookings, AI Automation %, Human
 * Escalations, Revenue"). Every number is computed from real rows.
 *
 * Two of the four tiles are honestly named for what exists today: there is no
 * booking entity or payment step yet (journey Steps 9-19 are not built), so
 * "Active Bookings" is *active journeys* and "Revenue" is the *quoted value*
 * of issued quotes — never presented as money actually received.
 */
export const dashboardSummaryResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  journeys: z.object({
    total: z.number().int().nonnegative(),
    /** Journeys not in a terminal state (closed / cancelled / declined / expired). */
    active: z.number().int().nonnegative(),
    byState: z.array(
      z.object({ state: journeyStateSchema, count: z.number().int().nonnegative() }),
    ),
  }),
  escalations: z.object({
    open: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    slaBreached: z.number().int().nonnegative(),
  }),
  automation: z.object({
    journeys: z.number().int().nonnegative(),
    /** Journeys that ever needed a human hand-off. */
    escalatedJourneys: z.number().int().nonnegative(),
    /** Share of journeys that never needed a person, 0-100; null until there is at least one journey. */
    percentAutomated: z.number().min(0).max(100).nullable(),
  }),
  quotes: z.object({
    issued: z.number().int().nonnegative(),
    pendingReview: z.number().int().nonnegative(),
    /** Sum of the latest version of each issued quote, per currency, in minor units. */
    quotedValue: z.array(
      z.object({ currency: z.string().length(3), minorUnits: z.number().int().nonnegative() }),
    ),
  }),
  customers: z.object({ total: z.number().int().nonnegative() }),
});
export type DashboardSummaryResponse = z.infer<typeof dashboardSummaryResponseSchema>;

export const listQuotesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
export type ListQuotesQuery = z.infer<typeof listQuotesQuerySchema>;

export const quoteListItemSchema = z.object({
  quoteId: z.string().uuid(),
  version: z.number().int().positive(),
  status: z.enum(['ISSUED', 'PENDING_REVIEW']),
  conversationId: z.string().uuid(),
  channel: channelSchema,
  customerRef: z.string(),
  vehicleName: z.string(),
  currency: z.string().length(3),
  total: moneySchema,
  deposit: moneySchema,
  validUntil: z.string().datetime(),
  createdAt: z.string().datetime(),
  requiresHumanReview: z.boolean(),
});
export type QuoteListItem = z.infer<typeof quoteListItemSchema>;

export const listQuotesResponseSchema = z.object({ items: z.array(quoteListItemSchema) });
export type ListQuotesResponse = z.infer<typeof listQuotesResponseSchema>;

/** A conversation as staff read it: what the customer said, what the concierge said, and what a person said. */
export const transcriptRoleSchema = z.enum(['CUSTOMER', 'CONCIERGE', 'STAFF']);
export type TranscriptRole = z.infer<typeof transcriptRoleSchema>;

export const transcriptMessageSchema = z.object({
  id: z.string().uuid(),
  role: transcriptRoleSchema,
  content: z.string(),
  /** AI_GENERATED | TEMPLATE | HUMAN for concierge/staff turns; null for the customer. */
  source: z.string().nullable(),
  stage: z.string().nullable(),
  authorUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;

export const transcriptParamsSchema = z.object({ conversationId: z.string().uuid() });
export type TranscriptParams = z.infer<typeof transcriptParamsSchema>;

export const transcriptResponseSchema = z.object({
  conversation: z.object({
    id: z.string().uuid(),
    channel: channelSchema,
    customerRef: z.string(),
    createdAt: z.string().datetime(),
  }),
  messages: z.array(transcriptMessageSchema),
  eligibility: z
    .object({ status: z.string(), reason: z.string(), decidedAt: z.string().datetime() })
    .nullable(),
  quote: quoteSnapshotSchema.nullable(),
  /**
   * What the customer has told the concierge about themselves as a driver.
   * The date of birth is PII and is never returned — only whether it was given.
   */
  driverDetails: z
    .object({
      nationality: z.string().nullable(),
      licenseType: z.string().nullable(),
      hasValidLicense: z.boolean().nullable(),
      passportProvided: z.boolean().nullable(),
      dateOfBirthProvided: z.boolean(),
    })
    .nullable(),
});
export type TranscriptResponse = z.infer<typeof transcriptResponseSchema>;

/** Human worker: a staff member answers the customer directly from the dashboard. */
export const staffReplyBodySchema = z
  .object({ message: z.string().trim().min(1).max(1000) })
  .strict();
export type StaffReplyBody = z.infer<typeof staffReplyBodySchema>;

export const staffReplyResponseSchema = z.object({
  delivered: z.boolean(),
  /**
   * SENT: handed to WhatsApp/Email. STORED: web chat (the customer sees it in
   * their chat). NOT_CONFIGURED / FAILED: nothing reached the customer.
   */
  delivery: z.enum(['SENT', 'STORED', 'NOT_CONFIGURED', 'FAILED']),
  message: transcriptMessageSchema.nullable(),
});
export type StaffReplyResponse = z.infer<typeof staffReplyResponseSchema>;
