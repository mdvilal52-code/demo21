import type { TranscriptMessage } from '@ai-concierge/contracts';
import { formatDateTime } from '../../lib/format';

const ROLE_STYLE: Record<
  TranscriptMessage['role'],
  { label: string; align: string; bubble: string }
> = {
  CUSTOMER: {
    label: 'Customer',
    align: 'justify-start',
    bubble: 'bg-white/10 text-cream-50',
  },
  CONCIERGE: {
    label: 'AI concierge',
    align: 'justify-end',
    bubble: 'border border-white/10 bg-emerald-900/70 text-cream-50',
  },
  STAFF: {
    label: 'Team member',
    align: 'justify-end',
    bubble: 'bg-copper-gradient text-ink-900',
  },
};

function sourceNote(message: TranscriptMessage): string {
  if (message.source === 'AI_GENERATED') return ' · Gemini';
  if (message.source === 'TEMPLATE') return ' · template';
  return '';
}

/** One chronological thread: what the customer said, what the concierge said, and what a person said. */
export function ConversationThread({ messages }: { messages: TranscriptMessage[] }) {
  if (messages.length === 0) {
    return <p className="text-sm text-cream-50/60">No messages yet.</p>;
  }
  return (
    <ol className="space-y-3" aria-label="Conversation">
      {messages.map((message) => {
        const style = ROLE_STYLE[message.role];
        return (
          <li key={message.id} className={`flex ${style.align}`}>
            <div className={`max-w-[88%] rounded-2xl px-4 py-2.5 text-sm ${style.bubble}`}>
              <p className="mb-1 text-[10px] uppercase tracking-[0.12em] opacity-70">
                {style.label}
                {sourceNote(message)} · {formatDateTime(message.createdAt)}
              </p>
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
