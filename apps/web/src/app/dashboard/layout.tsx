import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../lib/getCurrentUser';
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
      <DashboardNav />
      <main className="px-4 pb-16 sm:px-8">{children}</main>
    </div>
  );
}
