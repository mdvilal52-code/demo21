'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface DashboardNavItem {
  href: string;
  label: string;
}

/** The sections the signed-in role may see (chosen on the server by `navItemsFor`). */
export function DashboardNav({ items }: { items: DashboardNavItem[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap gap-2 px-4 py-3 sm:px-8" aria-label="Dashboard sections">
      {items.map((link) => {
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
