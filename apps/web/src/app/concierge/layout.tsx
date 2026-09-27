import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { BottomTabBar } from '../../components/concierge/BottomTabBar';
import { RegisterServiceWorker } from '../../components/concierge/RegisterServiceWorker';

export const metadata: Metadata = {
  title: 'AI Concierge',
  description: 'Rent a luxury car in Dubai by chatting with our AI concierge.',
  manifest: '/manifest.webmanifest',
  applicationName: 'AI Concierge',
  appleWebApp: { capable: true, title: 'Concierge', statusBarStyle: 'black-translucent' },
  icons: { icon: '/icon.svg', apple: '/icons/icon-192.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#072B22',
};

export default function ConciergeLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] pb-[calc(4rem+env(safe-area-inset-bottom))]">
      <RegisterServiceWorker />
      {children}
      <BottomTabBar />
    </div>
  );
}
