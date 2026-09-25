import { redirect } from 'next/navigation';
import { fetchProviderStatus, SessionExpiredError } from '../../../lib/adminApi';
import { GlassCard } from '../../../components/ui/GlassCard';
import { StatusChip } from '../../../components/ui/StatusChip';

const PROVIDER_LABELS = {
  whatsapp: 'WhatsApp (customer channel)',
  email: 'Email (customer channel)',
  smsNotification: 'SMS (staff escalation paging)',
  conversationalAi: 'Conversational AI (Gemini)',
  observability: 'Observability (OpenTelemetry)',
} as const;

export default async function SettingsPage() {
  let status;
  try {
    status = await fetchProviderStatus();
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/login');
    throw error;
  }

  return (
    <div className="mx-auto max-w-2xl py-8">
      <h1 className="font-display text-lg uppercase tracking-[0.14em] text-cream-50">Settings</h1>
      <p className="mt-2 text-sm text-cream-50/70">
        Which channels and providers are actually wired up right now — never a fake status.
      </p>

      <GlassCard className="mt-6">
        <dl className="space-y-4">
          {(Object.keys(PROVIDER_LABELS) as (keyof typeof PROVIDER_LABELS)[]).map((key) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <dt className="text-sm text-cream-50">{PROVIDER_LABELS[key]}</dt>
              <dd>
                <StatusChip tone={status[key] === 'CONFIGURED' ? 'success' : 'neutral'}>
                  {status[key] === 'CONFIGURED' ? 'Configured' : 'Not configured'}
                </StatusChip>
              </dd>
            </div>
          ))}
        </dl>
      </GlassCard>
    </div>
  );
}
