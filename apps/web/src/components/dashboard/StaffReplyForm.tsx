'use client';

import { useActionState, useEffect, useRef } from 'react';
import { sendStaffReplyAction } from '../../app/dashboard/journeys/[conversationId]/actions';
import {
  INITIAL_REPLY_STATE,
  type ReplyState,
} from '../../app/dashboard/journeys/[conversationId]/replyState';
import { PillButton } from '../ui/PillButton';

const TONE: Record<ReplyState['status'], string> = {
  idle: '',
  sent: 'text-success',
  not_delivered: 'text-danger',
  error: 'text-danger',
};

/** Human worker's reply box. The textarea clears only after a reply was really delivered. */
export function StaffReplyForm({ conversationId }: { conversationId: string }) {
  const [state, formAction, pending] = useActionState(
    sendStaffReplyAction.bind(null, conversationId),
    INITIAL_REPLY_STATE,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (state.status === 'sent' && textareaRef.current) textareaRef.current.value = '';
  }, [state]);

  return (
    <form action={formAction} className="mt-4 space-y-3" aria-label="Reply to the customer">
      <label
        htmlFor="staff-reply"
        className="block text-xs uppercase tracking-wide text-cream-50/70"
      >
        Reply as a team member
      </label>
      <textarea
        ref={textareaRef}
        id="staff-reply"
        name="message"
        required
        maxLength={1000}
        rows={3}
        placeholder="Write to the customer — it is sent over their own channel and recorded under your name."
        className="w-full rounded-2xl border border-white/10 bg-emerald-900/60 p-3 text-sm text-cream-50 placeholder:text-cream-50/40 focus:border-copper-300 focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-3">
        <PillButton type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Send reply'}
        </PillButton>
        {state.status !== 'idle' && (
          <p className={`text-sm ${TONE[state.status]}`} role="status" data-testid="reply-status">
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
