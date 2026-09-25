'use server';

import { revalidatePath } from 'next/cache';
import { resolveEscalationBodySchema } from '@ai-concierge/contracts';
import { assignEscalation, resolveEscalation } from '../../../lib/adminApi';

export async function assignEscalationAction(escalationCaseId: string): Promise<void> {
  await assignEscalation(escalationCaseId);
  revalidatePath('/dashboard/escalations');
}

export async function resolveEscalationAction(
  escalationCaseId: string,
  formData: FormData,
): Promise<void> {
  const parsed = resolveEscalationBodySchema.parse({
    resolution: formData.get('resolution'),
    resolutionNote: formData.get('resolutionNote'),
  });
  await resolveEscalation(escalationCaseId, parsed);
  revalidatePath('/dashboard/escalations');
}
