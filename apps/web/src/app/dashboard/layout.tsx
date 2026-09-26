import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../lib/getCurrentUser';
import { navItemsFor } from '../../lib/dashboardNav';
import { TopBar } from '../../components/dashboard/TopBar';
import { DashboardNav } from '../../components/dashboard/DashboardNav';
import { SessionKeepAlive } from '../../components/dashboard/SessionKeepAlive';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return (
    <div className="min-h-screen">
      <SessionKeepAlive />
      <TopBar user={user} />
      <DashboardNav items={navItemsFor(user.role).map(({ href, label }) => ({ href, label }))} />
      <main className="px-4 pb-8 sm:px-8">{children}</main>
      <p className="px-4 pb-10 text-center text-xs text-cream-50/40 sm:px-8">
        All times are shown in Dubai time (GST, UTC+4).
      </p>
    </div>
  );
}
