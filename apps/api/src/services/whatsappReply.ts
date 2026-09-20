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
    case 'NEEDS_INFO':
      return missingInfo.clarificationPrompt ?? 'Could you tell us a bit more about your request?';
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
