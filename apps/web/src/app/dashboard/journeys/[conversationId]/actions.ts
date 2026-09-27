'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { staffReplyBodySchema } from '@ai-concierge/contracts';
import { SessionExpiredError, sendStaffReply } from '../../../../lib/adminApi';
import type { ReplyState } from './replyState';

/**
 * Human worker: send a reply to the customer of this conversation. The result
 * is always reported truthfully — when the channel could not deliver (WhatsApp
 * or Email not configured, a send failure) the staff member is told the
 * customer did NOT receive it, never shown a reply that went nowhere.
 */
export async function sendStaffReplyAction(
  conversationId: string,
  previous: ReplyState,
  formData: FormData,
): Promise<ReplyState> {
  const nonce = previous.nonce + 1;
  const parsed = staffReplyBodySchema.safeParse({ message: formData.get('message') });
  if (!parsed.success) {
    return { status: 'error', message: 'Write a message of 1 to 1,000 characters.', nonce };
  }

  try {
    const result = await sendStaffReply(conversationId, parsed.data.message);
    revalidatePath(`/dashboard/journeys/${conversationId}`);
    if (result.delivered) {
      return {
        status: 'sent',
        message:
          result.delivery === 'STORED'
            ? "Sent. It appears in the customer's chat."
            : 'Sent to the customer.',
        nonce,
      };
    }
    return {
      status: 'not_delivered',
      message:
        result.delivery === 'NOT_CONFIGURED'
          ? 'This channel is not configured, so the customer did NOT receive your message.'
          : 'Sending failed, so the customer did NOT receive your message. Please try again.',
      nonce,
    };
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/login');
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Could not send the reply.',
      nonce,
    };
  }
}
