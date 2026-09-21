import { MissingInfoStatus, type MissingInfoResult } from '@ai-concierge/domain';

function summarizeCollected(collected: MissingInfoResult['collected']): string {
  const parts: string[] = [];
  if (collected.vehicle) {
    parts.push(`${collected.vehicle.make} ${collected.vehicle.model}`);
  }
  if (collected.pickupDate) {
    const pickup = collected.pickupDate.slice(0, 10);
    const returnPart = collected.returnDate ? ` to ${collected.returnDate.slice(0, 10)}` : '';
    parts.push(`${pickup}${returnPart}`);
  }
  if (collected.pickupLocation) {
    parts.push(collected.pickupLocation.city);
  }
  return parts.join(', ');
}

/**
 * Deterministic, template-based WhatsApp reply text — same zero-hallucination
 * discipline as Steps 1-4 (`clarificationPromptBuilder.ts`). Never an LLM
 * call, so this never says anything Step 4's own result doesn't support.
 */
export function buildWhatsAppReplyText(missingInfo: MissingInfoResult): string {
  switch (missingInfo.status) {
    case MissingInfoStatus.COMPLETE: {
      const summary = summarizeCollected(missingInfo.collected);
      return `Thank you — I have everything I need${summary ? ` (${summary})` : ''}. Our team will follow up shortly with your quote.`;
    }
    case MissingInfoStatus.NEEDS_INFO:
      return (
        missingInfo.clarificationPrompt ?? 'Could you share a few more details so we can proceed?'
      );
    case MissingInfoStatus.EXPIRED:
      return 'This enquiry has been open for a while — could you resend your request so we can start fresh?';
    case MissingInfoStatus.NOT_APPLICABLE:
      return "Thanks for reaching out — let us know if you'd like to book a car and we'll take it from there.";
    case MissingInfoStatus.CANCELLED:
      return "No problem — I've cancelled that booking request. Let us know whenever you'd like to start a new one.";
    default:
      return 'Thank you for your message — our team will get back to you shortly.';
  }
}
