import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Concierge',
  description: 'Tell us what you need — our AI concierge will take it from here.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-emerald-gradient font-body antialiased">{children}</body>
    </html>
  );
}
