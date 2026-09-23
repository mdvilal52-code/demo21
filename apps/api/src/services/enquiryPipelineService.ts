import type {
  DateLocationExtractionOrchestrator,
  IntentEngine,
  MissingInfoOrchestrator,
  VehicleDeterminationOrchestrator,
} from '@ai-concierge/ai';
import { findOpenConversationForCustomer, type Channel, type PrismaClient } from '@ai-concierge/db';
import type { TenantId } from '@ai-concierge/domain';
import type { Queue } from 'bullmq';
import { submitEnquiry, continueEnquiry } from './enquiryService.js';
import { extractDatesAndLocation } from './dateLocationService.js';
import { determineVehicle } from './vehicleService.js';
import { checkMissingInfo } from './missingInfoService.js';

export interface EnquiryPipelineDeps {
  prisma: PrismaClient;
  intentEngine: IntentEngine;
  postEnquiryQueue: Queue;
  dateLocationOrchestrator: DateLocationExtractionOrchestrator;
  vehicleOrchestrator: VehicleDeterminationOrchestrator;
  missingInfoOrchestrator: MissingInfoOrchestrator;
}

export interface RunFullEnquiryPipelineInput {
  tenantId: TenantId;
  channel: Channel;
  customerRef: string;
  message: string;
  requestId: string;
}

export interface FullEnquiryPipelineResult {
  enquiry: Awaited<ReturnType<typeof submitEnquiry>>;
  dateLocation: Awaited<ReturnType<typeof extractDatesAndLocation>>;
  vehicle: Awaited<ReturnType<typeof determineVehicle>>;
  missingInfo: Awaited<ReturnType<typeof checkMissingInfo>>;
}

/**
 * Sequentially runs Steps 1-4 for a single inbound message from any channel.
 * This is a fixed, hardcoded sequence for exactly one message — not the real
 * persisted journey state machine (MASTER-PLAN.md's Event/Workflow Engine),
 * which still doesn't exist (see PHASE-4.md §13, docs/PHASE-5-CHANNELS.md). Each step
 * below is the exact same already-tested service its own REST endpoint
 * calls; nothing here re-implements Steps 1-4's logic.
 *
 * The message continues the customer's open conversation on this channel
 * (`findOpenConversationForCustomer`) instead of always starting a fresh
 * one, so a reply to a clarification question is merged with what an
 * earlier message in the same conversation already resolved rather than
 * evaluated on its own — see docs/PHASE-5-CHANNELS.md's amendment for why. A new
 * conversation starts once the open one reaches a terminal Step 4 outcome
 * (COMPLETE/EXPIRED/CANCELLED) or none exists yet. This lookup happens for every
 * channel that calls this function, not just WhatsApp — today that's only
 * WhatsApp in practice, but the behavior is channel-agnostic like the rest
 * of this function.
 */
export async function runFullEnquiryPipeline(
  deps: EnquiryPipelineDeps,
  input: RunFullEnquiryPipelineInput,
): Promise<FullEnquiryPipelineResult> {
  const openConversation = await findOpenConversationForCustomer(
    deps.prisma,
    input.tenantId,
    input.channel,
    input.customerRef,
  );

  const enquiry = openConversation
    ? await continueEnquiry(
        { prisma: deps.prisma, intentEngine: deps.intentEngine },
        {
          tenantId: input.tenantId,
          conversationId: openConversation.id,
          channel: input.channel,
          message: input.message,
          requestId: input.requestId,
        },
      )
    : await submitEnquiry(
        {
          prisma: deps.prisma,
          intentEngine: deps.intentEngine,
          postEnquiryQueue: deps.postEnquiryQueue,
        },
        {
          tenantId: input.tenantId,
          channel: input.channel,
          customerRef: input.customerRef,
          message: input.message,
          requestId: input.requestId,
        },
      );

  const dateLocation = await extractDatesAndLocation(
    { prisma: deps.prisma, orchestrator: deps.dateLocationOrchestrator },
    {
      tenantId: input.tenantId,
      conversationId: enquiry.conversationId,
      requestId: input.requestId,
    },
  );

  const vehicle = await determineVehicle(
    { prisma: deps.prisma, orchestrator: deps.vehicleOrchestrator },
    {
      tenantId: input.tenantId,
      conversationId: enquiry.conversationId,
      requestId: input.requestId,
    },
  );

  const missingInfo = await checkMissingInfo(
    { prisma: deps.prisma, orchestrator: deps.missingInfoOrchestrator },
    {
      tenantId: input.tenantId,
      conversationId: enquiry.conversationId,
      requestId: input.requestId,
    },
  );

  return { enquiry, dateLocation, vehicle, missingInfo };
}
