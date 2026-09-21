import type { MissingInfoResult } from '@ai-concierge/domain';

function formatCollectedSummary(collected: MissingInfoResult['collected']): string {
  const parts: string[] = [];
  if (collected.vehicle) {
    parts.push(`${collected.vehicle.make} ${collected.vehicle.model}`);
  }
  if (collected.pickupDate && collected.returnDate) {
    const pickup = new Date(collected.pickupDate).toDateString();
    const dropoff = new Date(collected.returnDate).toDateString();
    parts.push(`${pickup} to ${dropoff}`);
  }
  if (collected.pickupLocation) {
    parts.push(`pickup at ${collected.pickupLocation.normalized}`);
  }
  return parts.join(', ');
}

/**
 * Maps a Step 4 result to the WhatsApp auto-reply text. Deterministic and
 * template-based, same discipline as clarificationPromptBuilder — this never
 * invents copy the underlying step didn't already produce or verify.
 */
export function buildWhatsAppReplyText(missingInfo: MissingInfoResult): string {
  switch (missingInfo.status) {
    case 'NEEDS_INFO': {
      const prompt =
        missingInfo.clarificationPrompt ?? 'Could you tell us a bit more about your request?';
      const vehicle = missingInfo.collected.vehicle;
      // Acknowledge a vehicle already resolved in an earlier message of this
      // conversation, so asking for the remaining details doesn't read as
      // ignoring what the customer already told us.
      return vehicle
        ? `Great choice! The ${vehicle.make} ${vehicle.model} is available. ${prompt}`
        : prompt;
    }
    case 'COMPLETE': {
      const summary = formatCollectedSummary(missingInfo.collected);
      return (
        `Thanks! We've got everything we need${summary ? ` — ${summary}` : ''}. ` +
        'Our team will follow up shortly to confirm availability and pricing.'
      );
    }
    case 'EXPIRED':
      return "This request expired since we didn't hear back in time. Please send a new message to start again.";
    case 'NOT_APPLICABLE':
    default:
      return 'Thanks for reaching out! One of our team members will get back to you shortly.';
  }
}

export const WHATSAPP_UNSUPPORTED_MESSAGE_TYPE_REPLY =
  'Sorry, we can only read text messages right now — could you send your request as text?';

export const WHATSAPP_MESSAGE_TOO_LONG_REPLY =
  'Sorry, that message is too long. Could you send a shorter version of your request?';

/**
 * The WhatsApp conversation-stage machine's own copy
 * (`whatsappConversationState.ts`) — distinct from `buildWhatsAppReplyText`
 * above, which only ever maps a *Step 4* result. These four cover the
 * confirmation exchange that happens before Step 4 has anything to evaluate
 * yet (Stage 1 -> Stage 2 of the required conversation flow).
 */
export const WHATSAPP_BOOKING_INVITATION_REPLY =
  "Thanks for reaching out! 😊 Let us know if you'd like to book a car and we'll take it from there.";

export const WHATSAPP_WHICH_CAR_REPLY =
  'Great! 😊 Which car would you like to book? For example, Lamborghini, Mercedes, Audi, or another luxury car? Please let us know your preferred car, and our team will assist you.';

export const WHATSAPP_BOOKING_DECLINED_REPLY =
  "No problem! Whenever you'd like to book a car, just message us here and we'll be happy to help. 😊";

export const WHATSAPP_CONFIRMATION_NUDGE_REPLY =
  "Sorry, I didn't quite catch that — would you like to book a car with us today?";
