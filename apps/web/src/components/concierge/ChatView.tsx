'use client';

import { useEffect, useRef, useState } from 'react';
import { customerStepFor } from '../../lib/customerJourney';
import { formatDateTime } from '../../lib/format';
import { PillButton } from '../ui/PillButton';
import { ProgressBar } from './ProgressBar';
import { QuoteCard } from './QuoteCard';
import { useChatSession } from './useChatSession';

const MAX_LENGTH = 1000;
const SUGGESTIONS = [
  "I'd like to rent a Lamborghini Urus in Dubai Marina from 15 to 19 October",
  'What cars do you have available?',
  'I want to speak to a person',
];

function TypingBubble() {
  return (
    <li className="flex justify-start" aria-label="The concierge is typing">
      <div className="rounded-2xl border border-white/10 bg-emerald-800/80 px-4 py-3">
        <span className="flex gap-1" aria-hidden="true">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="h-2 w-2 animate-bounce rounded-full bg-cream-50/60"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
      </div>
    </li>
  );
}

/**
 * The customer's chat with the concierge. Everything the customer sees is what
 * the server holds for their session: the AI's replies, a team member's
 * replies (clearly labelled), and their own messages. Unsent or failed messages
 * stay visible with a retry, so nothing typed is ever silently lost.
 */
export function ChatView() {
  const chat = useChatSession();
  const [draft, setDraft] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const step = customerStepFor(chat.session?.journeyState ?? null);
  const quote = chat.session?.quote ?? null;
  const canConfirm = quote !== null && chat.session?.journeyState === 'QUOTE_ISSUED';
  const empty = chat.messages.length === 0 && chat.pending.length === 0;

  useEffect(() => {
    const box = boxRef.current;
    if (box && followRef.current) box.scrollTop = box.scrollHeight;
  });

  function submit() {
    const text = draft.trim();
    if (!text || chat.sending) return;
    chat.send(text);
    setDraft('');
    followRef.current = true;
  }

  return (
    <div className="mx-auto flex h-[calc(100dvh-4rem-env(safe-area-inset-bottom))] max-w-xl flex-col">
      <header className="border-b border-white/10 px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="font-display text-sm uppercase tracking-[0.18em] text-cream-50">
            Concierge
          </h1>
          <p
            className={`rounded-pill border px-3 py-1 text-[11px] font-medium uppercase tracking-wide ${
              chat.session?.escalated
                ? 'border-copper-300/60 bg-copper-500/15 text-copper-100'
                : 'border-white/15 text-cream-50/70'
            }`}
            data-testid="chat-step"
          >
            {step.label}
          </p>
        </div>
        <ProgressBar state={chat.session?.journeyState ?? null} />
      </header>

      {chat.status === 'offline' && (
        <p className="bg-warning/15 px-4 py-2 text-center text-xs text-warning" role="status">
          You are offline. Reconnect to keep chatting — anything you type will wait here.
        </p>
      )}

      <div
        ref={boxRef}
        onScroll={(event) => {
          const box = event.currentTarget;
          followRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        }}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        {empty && chat.status !== 'loading' && (
          <div className="mx-auto max-w-sm pt-6 text-center">
            <p className="font-display text-base text-cream-50">Hello, how can I help?</p>
            <p className="mt-2 text-sm text-cream-50/70">
              Tell me the car, the dates and where you would like to pick it up — I will take care
              of the rest.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => chat.send(suggestion)}
                  className="rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-left text-sm text-cream-50/90 transition-colors hover:bg-emerald-700/40"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        <ol className="space-y-3" aria-live="polite" aria-label="Conversation">
          {chat.messages.map((message) => {
            const mine = message.role === 'CUSTOMER';
            const staff = message.role === 'STAFF';
            return (
              <li key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[86%] rounded-2xl px-4 py-2.5 text-sm ${
                    mine
                      ? 'bg-copper-gradient text-ink-900'
                      : staff
                        ? 'border border-copper-300/60 bg-emerald-700/70 text-cream-50'
                        : 'border border-white/10 bg-emerald-800/80 text-cream-50'
                  }`}
                >
                  {staff && (
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-copper-300">
                      Team member
                    </p>
                  )}
                  <p className="whitespace-pre-wrap break-words">{message.content}</p>
                  <p
                    className={`mt-1 text-[10px] ${mine ? 'text-ink-900/60' : 'text-cream-50/40'}`}
                  >
                    {formatDateTime(message.createdAt).split(', ')[1]}
                  </p>
                </div>
              </li>
            );
          })}

          {chat.pending.map((item) => (
            <li key={item.clientMessageId} className="flex justify-end">
              <div className="max-w-[86%] rounded-2xl bg-copper-gradient px-4 py-2.5 text-sm text-ink-900 opacity-80">
                <p className="whitespace-pre-wrap break-words">{item.text}</p>
                {item.failed ? (
                  <button
                    type="button"
                    onClick={() => chat.retry(item.clientMessageId)}
                    className="mt-1 text-[11px] font-semibold underline"
                  >
                    {item.error ?? 'Not sent.'} Tap to retry.
                  </button>
                ) : (
                  <p className="mt-1 text-[10px] text-ink-900/60">Sending…</p>
                )}
              </div>
            </li>
          ))}

          {chat.sending && <TypingBubble />}
        </ol>

        {quote && (
          <div className="mt-4 space-y-3">
            <QuoteCard quote={quote} />
            {canConfirm && (
              <PillButton
                className="w-full"
                disabled={chat.sending}
                onClick={() => chat.send('Yes please, go ahead and book it')}
              >
                Confirm with our team
              </PillButton>
            )}
          </div>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="border-t border-white/10 bg-emerald-900/70 px-3 py-3"
      >
        <label htmlFor="chat-input" className="sr-only">
          Your message
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id="chat-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value.slice(0, MAX_LENGTH))}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={1}
            maxLength={MAX_LENGTH}
            placeholder="Message the concierge…"
            enterKeyHint="send"
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded-2xl border border-white/10 bg-emerald-900/80 px-4 py-3 text-sm text-cream-50 placeholder:text-cream-50/40 focus:border-copper-300 focus:outline-none"
          />
          <PillButton
            type="submit"
            disabled={!draft.trim() || chat.sending}
            className="h-[44px] px-5 py-0"
          >
            Send
          </PillButton>
        </div>
        {draft.length > MAX_LENGTH - 100 && (
          <p className="mt-1 text-right text-[11px] text-cream-50/50">
            {draft.length} / {MAX_LENGTH}
          </p>
        )}
      </form>
    </div>
  );
}
