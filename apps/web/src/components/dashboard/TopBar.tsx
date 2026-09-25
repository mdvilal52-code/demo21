import type { AuthenticatedUser } from '@ai-concierge/domain';
import { Monogram } from '../ui/Monogram';
import { SignOutButton } from './SignOutButton';

export function TopBar({ user }: { user: AuthenticatedUser }) {
  return (
    <header className="flex items-center justify-between border-b border-white/10 px-4 py-4 sm:px-8">
      <div className="flex items-center gap-3">
        <Monogram />
        <span className="font-display text-sm uppercase tracking-[0.22em] text-cream-50 sm:text-base">
          AI Concierge
        </span>
      </div>
      <div className="flex items-center gap-4">
        <div className="hidden text-right sm:block">
          <p className="text-sm text-cream-50">{user.email}</p>
          <p className="text-xs uppercase tracking-wide text-cream-50/60">{user.role}</p>
        </div>
        <SignOutButton />
      </div>
    </header>
  );
}
