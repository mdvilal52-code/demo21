'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/dashboard', label: 'Home' },
  { href: '/dashboard/escalations', label: 'Escalations' },
  { href: '/dashboard/journeys', label: 'Journeys' },
  { href: '/dashboard/customers', label: 'Customers' },
  { href: '/dashboard/fleet', label: 'Fleet' },
  { href: '/dashboard/settings', label: 'Settings' },
] as const;

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap gap-2 px-4 py-3 sm:px-8" aria-label="Dashboard sections">
      {LINKS.map((link) => {
        const isActive =
          link.href === '/dashboard' ? pathname === link.href : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive ? 'page' : undefined}
            className={`rounded-pill px-4 py-2 text-xs font-medium uppercase tracking-wide transition-colors duration-150 ${
              isActive
                ? 'bg-copper-gradient text-ink-900'
                : 'border border-white/10 text-cream-50/70 hover:bg-emerald-700/40'
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
