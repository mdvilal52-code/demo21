import {
  saveCustomerContact,
  type Channel,
  type CustomerContactPatch,
  type PrismaClient,
} from '@ai-concierge/db';
import type { Customer, TenantId } from '@ai-concierge/domain';
import { extractContact } from '../lib/contactExtraction.js';

/**
 * What a channel already tells us about who the customer is: an email
 * conversation's customerRef IS the email address, a WhatsApp one's IS the
 * phone number. A web chat tells us nothing until the customer types it.
 */
export function contactFromChannelIdentity(
  channel: Channel,
  customerRef: string,
): CustomerContactPatch {
  if (channel === 'EMAIL' && customerRef.includes('@')) {
    return { email: customerRef.trim().toLowerCase() };
  }
  if (channel === 'WHATSAPP') {
    const digits = customerRef.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) return { phone: `+${digits}` };
  }
  return {};
}

export interface CaptureContactInput {
  tenantId: TenantId;
  channel: Channel;
  customerRef: string;
  message: string;
}

/**
 * Saves the customer's contact details to the CRM — from the channel itself
 * and from anything they typed in this message (email, phone, "my name is").
 * Only ever adds information; a message without contact details changes
 * nothing. Returns the customer when something was saved.
 */
export async function captureCustomerContact(
  deps: { prisma: PrismaClient },
  input: CaptureContactInput,
): Promise<Customer | null> {
  const typed = extractContact(input.message);
  const patch: CustomerContactPatch = {
    ...contactFromChannelIdentity(input.channel, input.customerRef),
    ...typed,
  };
  if (!patch.email && !patch.phone && !patch.displayName) return null;
  return saveCustomerContact(
    deps.prisma,
    input.tenantId,
    { channel: input.channel, customerRef: input.customerRef },
    patch,
    new Date(),
  );
}
