import Link from 'next/link';
import { redirect } from 'next/navigation';
import { fetchDashboardSummary, SessionExpiredError } from '../../lib/adminApi';
import { getCurrentUser } from '../../lib/getCurrentUser';
import { navItemsFor } from '../../lib/dashboardNav';
import { formatMoney } from '../../lib/format';
import { endedCount, milestoneCounts, needsPersonCount } from '../../lib/journeyMilestones';
import { AutoRefresh } from '../../components/dashboard/AutoRefresh';
import { JourneyStepper } from '../../components/dashboard/JourneyStepper';
import { CopperCard } from '../../components/ui/CopperCard';
import { GlassCard } from '../../components/ui/GlassCard';
import { StatTile } from '../../components/ui/StatTile';

export const metadata = { title: 'Home · AI Concierge' };

const SECTION_COPY: Record<string, string> = {
  '/dashboard/escalations':
    'Cases the AI could not resolve — assign, answer and resolve them here.',
  '/dashboard/journeys': 'Every customer conversation and where it stands in the 19-step flow.',
  '/dashboard/quotes': 'Every quote the concierge has issued, with its total and validity.',
  '/dashboard/customers': 'CRM records, kept in sync automatically as journeys progress.',
  '/dashboard/fleet': 'The vehicle catalog and its live pricing profile.',
  '/dashboard/audit': 'Who did what, and when — the append-only record.',
  '/dashboard/security': 'Sign-ins, lockouts and anomalies worth a look.',
  '/dashboard/settings': 'Which channels and providers are actually configured.',
};

export default async function DashboardHomePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  let summary;
  try {
    summary = await fetchDashboardSummary();
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/login');
    throw error;
  }

  const { journeys, escalations, automation, quotes } = summary;
  const [primaryValue, ...otherValues] = quotes.quotedValue;
  const needsAttention = escalations.open + escalations.inProgress;

  return (
    <div className="mx-auto max-w-5xl py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-lg uppercase tracking-[0.14em] text-cream-50">
            Welcome, {user.email}
          </h1>
          <p className="mt-2 text-sm text-cream-50/70">
            The concierge at a glance — every number below comes straight from live data.
          </p>
        </div>
        <AutoRefresh />
      </div>

      <GlassCard className="mt-6">
        <h2 className="mb-4 text-xs uppercase tracking-[0.14em] text-cream-50/70">
          Customer journey
        </h2>
        <JourneyStepper
          milestones={milestoneCounts(journeys.byState)}
          needsPerson={needsPersonCount(journeys.byState)}
          ended={endedCount(journeys.byState)}
        />
      </GlassCard>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatTile
          label="Active journeys"
          value={String(journeys.active)}
          hint={`${journeys.total} journeys in total`}
        />
        <StatTile
          label="AI automation"
          value={automation.percentAutomated === null ? '—' : `${automation.percentAutomated}%`}
          hint={
            automation.journeys === 0
              ? 'No journeys yet'
              : `${automation.journeys - automation.escalatedJourneys} of ${automation.journeys} never needed a person`
          }
          tone="success"
        />
        <StatTile
          label="Human escalations"
          value={String(needsAttention)}
          hint={
            escalations.slaBreached > 0
              ? `${escalations.slaBreached} past their SLA`
              : `${escalations.open} open · ${escalations.inProgress} in progress`
          }
          tone={escalations.slaBreached > 0 ? 'danger' : 'default'}
        />
        <StatTile
          label="Quoted value"
          value={primaryValue ? formatMoney(primaryValue.minorUnits, primaryValue.currency) : '—'}
          hint={
            quotes.issued === 0
              ? 'No quotes issued yet'
              : `${quotes.issued} issued quote${quotes.issued === 1 ? '' : 's'} — not money received${
                  otherValues.length
                    ? `; plus ${otherValues.map((v) => formatMoney(v.minorUnits, v.currency)).join(', ')}`
                    : ''
                }`
          }
        />
      </div>

      {needsAttention > 0 && (
        <Link
          href="/dashboard/escalations?status=OPEN"
          className="mt-4 block rounded-card border border-danger/40 bg-danger/10 p-4 text-sm text-danger"
        >
          {needsAttention} case{needsAttention === 1 ? '' : 's'} need a person — open the queue →
        </Link>
      )}

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {navItemsFor(user.role)
          .filter((item) => item.href !== '/dashboard')
          .map((item) => (
            <Link key={item.href} href={item.href}>
              <CopperCard className="h-full transition-transform duration-150 hover:scale-[1.01]">
                <h2 className="font-display text-sm uppercase tracking-wide text-ink-900">
                  {item.label}
                </h2>
                <p className="mt-2 text-sm text-ink-900/80">{SECTION_COPY[item.href] ?? ''}</p>
              </CopperCard>
            </Link>
          ))}
      </div>
    </div>
  );
}
