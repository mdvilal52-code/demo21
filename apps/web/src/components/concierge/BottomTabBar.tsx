'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const ICON_PROPS = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const TABS: { href: string; label: string; icon: ReactNode }[] = [
  {
    href: '/concierge',
    label: 'Home',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M3 11.5 12 4l9 7.5" />
        <path d="M5.5 10.5V20h13v-9.5" />
      </svg>
    ),
  },
  {
    href: '/concierge/chat',
    label: 'Chat',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M4 5h16v11H9l-5 4V5Z" />
      </svg>
    ),
  },
  {
    href: '/concierge/requests',
    label: 'Requests',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M6 3h9l4 4v14H6V3Z" />
        <path d="M14 3v5h5M9 13h7M9 17h7" />
      </svg>
    ),
  },
  {
    href: '/concierge/profile',
    label: 'Profile',
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
      </svg>
    ),
  },
];

/** Glass tab bar with a copper active state (docs/DESIGN-SYSTEM.md BottomTabBar). */
export function BottomTabBar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Concierge sections"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-white/10 bg-emerald-900/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-md"
    >
      <ul className="mx-auto flex h-16 max-w-xl items-stretch justify-around">
        {TABS.map((tab) => {
          const active =
            tab.href === '/concierge' ? pathname === tab.href : pathname.startsWith(tab.href);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={`flex h-full flex-col items-center justify-center gap-1 text-[11px] font-medium uppercase tracking-wide transition-colors duration-150 ${
                  active ? 'text-copper-300' : 'text-cream-50/60 hover:text-cream-50'
                }`}
              >
                <span
                  className={`flex h-7 w-12 items-center justify-center rounded-pill ${
                    active ? 'bg-copper-500/20' : ''
                  }`}
                >
                  {tab.icon}
                </span>
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
