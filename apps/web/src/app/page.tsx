import Link from 'next/link';
import { Monogram } from '../components/ui/Monogram';
import { EnquiryForm } from '../components/EnquiryForm';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-16">
      <Monogram />
      <EnquiryForm />
      <div className="flex flex-col items-center gap-3 text-sm">
        <Link
          href="/concierge"
          className="rounded-pill border border-copper-300 px-6 py-2.5 font-medium text-copper-100 transition-colors duration-150 hover:bg-emerald-700/40"
        >
          Chat with the concierge — open the app
        </Link>
        <Link href="/login" className="text-xs uppercase tracking-wide text-cream-50/60 underline">
          Staff sign in
        </Link>
      </div>
    </main>
  );
}
