import type { CreateEnquiryResponse } from '@ai-concierge/contracts';
import { formatFieldName } from '../lib/format';
import { CopperCard } from './ui/CopperCard';
import { StatusChip } from './ui/StatusChip';

export function IntentResult({ response }: { response: CreateEnquiryResponse }) {
  const { intent } = response;
  const needsClarification = intent.status === 'NEEDS_CLARIFICATION';

  return (
    <CopperCard className="mt-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium uppercase tracking-wide text-ink-900">
          {intent.intentType.replace(/_/g, ' ')}
        </span>
        <StatusChip tone={needsClarification ? 'warning' : 'success'}>
          {needsClarification ? 'Needs info' : 'Recognized'}
        </StatusChip>
      </div>

      <dl className="mt-3 space-y-1 text-sm text-ink-900/90">
        {intent.entities.vehicleIntent && (
          <div className="flex justify-between">
            <dt>Vehicle</dt>
            <dd className="font-medium">{intent.entities.vehicleIntent}</dd>
          </div>
        )}
        {intent.entities.location && (
          <div className="flex justify-between">
            <dt>Location</dt>
            <dd className="font-medium">{intent.entities.location}</dd>
          </div>
        )}
        {intent.entities.pickupDate && (
          <div className="flex justify-between">
            <dt>Pickup</dt>
            <dd className="font-medium">
              {new Date(intent.entities.pickupDate).toLocaleDateString()}
            </dd>
          </div>
        )}
        {intent.entities.returnDate && (
          <div className="flex justify-between">
            <dt>Return</dt>
            <dd className="font-medium">
              {new Date(intent.entities.returnDate).toLocaleDateString()}
            </dd>
          </div>
        )}
      </dl>

      {needsClarification && intent.clarificationPrompt && (
        <p className="mt-3 text-sm font-medium text-ink-900">{intent.clarificationPrompt}</p>
      )}

      {intent.missingFields.length > 0 && (
        <p className="mt-2 text-xs text-ink-600">
          Missing: {intent.missingFields.map(formatFieldName).join(', ')}
        </p>
      )}
    </CopperCard>
  );
}
