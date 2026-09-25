import Link from 'next/link';
import { getCurrentUser } from '../../lib/getCurrentUser';
import { CopperCard } from '../../components/ui/CopperCard';

const SECTIONS = [
  {
    href: '/dashboard/escalations',
    title: 'Escalations',
    description: 'Cases the AI could not resolve — assign and resolve them here.',
  },
  {
    href: '/dashboard/journeys',
    title: 'Journeys',
    description: 'Every customer conversation and where it stands in the 19-step flow.',
  },
  {
    href: '/dashboard/customers',
    title: 'Customers',
    description: 'CRM records, kept in sync automatically as journeys progress.',
  },
  {
    href: '/dashboard/fleet',
    title: 'Fleet',
    description: 'The vehicle catalog and its live pricing profile.',
  },
  {
    href: '/dashboard/settings',
    title: 'Settings',
    description: 'Which channels and providers are actually configured.',
  },
] as const;

export default async function DashboardHomePage() {
  const user = await getCurrentUser();

  return (
    <div className="mx-auto max-w-4xl py-8">
      <h1 className="font-display text-lg uppercase tracking-[0.14em] text-cream-50">
        Welcome{user ? `, ${user.email}` : ''}
      </h1>
      <p className="mt-2 text-sm text-cream-50/70">Pick a section to get started.</p>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {SECTIONS.map((section) => (
          <Link key={section.href} href={section.href}>
            <CopperCard className="h-full transition-transform duration-150 hover:scale-[1.01]">
              <h2 className="font-display text-sm uppercase tracking-wide text-ink-900">
                {section.title}
              </h2>
              <p className="mt-2 text-sm text-ink-600">{section.description}</p>
            </CopperCard>
          </Link>
        ))}
      </div>
    </div>
  );
}
