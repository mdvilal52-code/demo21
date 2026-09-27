'use client';

import Link from 'next/link';
import { useState } from 'react';
import { GlassCard } from '../ui/GlassCard';
import { PillButton } from '../ui/PillButton';
import { StatusChip } from '../ui/StatusChip';
import { InstallPrompt } from './InstallPrompt';
import { useChatSession } from './useChatSession';

/**
 * Profile for a customer who has no account: there is nothing to sign in to,
 * so this screen is honest about that — what identifies them (this browser),
 * how to install the app, what is not available yet, and how to start over.
 */
export function ProfileView() {
  const chat = useChatSession();
  const [confirming, setConfirming] = useState(false);
  const conversationId = chat.session?.conversationId ?? null;

  return (
    <div className="mx-auto max-w-xl px-4 pb-8 pt-8">
      <h1 className="font-display text-base uppercase tracking-[0.18em] text-cream-50">Profile</h1>

      <div className="mt-5 space-y-4">
        <GlassCard>
          <p className="text-xs uppercase tracking-[0.14em] text-cream-50/70">You</p>
          <p className="mt-2 text-sm text-cream-50">Guest on this device</p>
          <p className="mt-1 text-xs text-cream-50/60">
            You do not need an account. Your chat is saved to this browser, so you can close the app
            and come back to the same conversation. Our team can read it to help you.
          </p>
        </GlassCard>

        <GlassCard>
          <p className="text-xs uppercase tracking-[0.14em] text-cream-50/70">Install</p>
          <div className="mt-3">
            <InstallPrompt />
          </div>
        </GlassCard>

        <GlassCard>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs uppercase tracking-[0.14em] text-cream-50/70">Notifications</p>
            <StatusChip tone="neutral">Not configured</StatusChip>
          </div>
          <p className="mt-2 text-sm text-cream-50/70">
            Push notifications are not switched on yet. Keep the chat open, or come back to it, to
            see a reply from our team.
          </p>
        </GlassCard>

        <GlassCard>
          <p className="text-xs uppercase tracking-[0.14em] text-cream-50/70">Conversation</p>
          {confirming ? (
            <div className="mt-3 space-y-3">
              <p className="text-sm text-cream-50/80">
                Start a fresh conversation? Your current one stays with our team, but it will no
                longer show on this device.
              </p>
              <div className="flex gap-3">
                <PillButton
                  onClick={() => {
                    chat.startNew();
                    setConfirming(false);
                  }}
                >
                  Yes, start new
                </PillButton>
                <PillButton variant="outline" onClick={() => setConfirming(false)}>
                  Keep this one
                </PillButton>
              </div>
            </div>
          ) : (
            <div className="mt-3">
              <p className="mb-3 text-xs text-cream-50/60">
                {conversationId ? `Reference ${conversationId.slice(0, 8)}` : 'No conversation yet'}
              </p>
              <PillButton
                variant="outline"
                onClick={() => setConfirming(true)}
                disabled={!conversationId}
              >
                Start a new conversation
              </PillButton>
            </div>
          )}
        </GlassCard>

        <p className="text-center text-xs text-cream-50/50">
          <Link href="/login" className="underline">
            Staff sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
