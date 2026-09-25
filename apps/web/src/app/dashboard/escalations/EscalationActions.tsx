import { EscalationStatus, type EscalationStatusValue } from '@ai-concierge/domain';
import { PillButton } from '../../../components/ui/PillButton';
import { assignEscalationAction, resolveEscalationAction } from './actions';

export function EscalationActions({
  escalationCaseId,
  status,
  assignedToUserId,
  currentUserId,
}: {
  escalationCaseId: string;
  status: EscalationStatusValue;
  assignedToUserId: string | null;
  currentUserId: string;
}) {
  if (status === EscalationStatus.OPEN) {
    return (
      <form action={assignEscalationAction.bind(null, escalationCaseId)} className="mt-4">
        <PillButton type="submit">Assign to me</PillButton>
      </form>
    );
  }

  if (status === EscalationStatus.IN_PROGRESS) {
    if (assignedToUserId !== currentUserId) {
      return (
        <p className="mt-4 text-xs uppercase tracking-wide text-cream-50/50">
          Assigned to another staff member
        </p>
      );
    }

    return (
      <form
        action={resolveEscalationAction.bind(null, escalationCaseId)}
        className="mt-4 space-y-3"
      >
        <fieldset className="flex gap-4">
          <legend className="mb-2 text-xs uppercase tracking-wide text-cream-50/70">
            Resolution
          </legend>
          <label className="flex items-center gap-2 text-sm text-cream-50">
            <input
              type="radio"
              name="resolution"
              value="APPROVED"
              required
              className="accent-copper-500"
            />
            Approve
          </label>
          <label className="flex items-center gap-2 text-sm text-cream-50">
            <input
              type="radio"
              name="resolution"
              value="REJECTED"
              required
              className="accent-copper-500"
            />
            Reject
          </label>
        </fieldset>
        <textarea
          name="resolutionNote"
          required
          minLength={1}
          maxLength={1000}
          rows={2}
          placeholder="Note for the record — what you decided and why"
          className="w-full rounded-2xl border border-white/10 bg-emerald-900/60 p-3 text-sm text-cream-50 placeholder:text-cream-50/40 focus:border-copper-300 focus:outline-none"
        />
        <PillButton type="submit">Resolve</PillButton>
      </form>
    );
  }

  return null;
}
