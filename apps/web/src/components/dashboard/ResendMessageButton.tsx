'use client';

import { useState, useTransition } from 'react';
import { resendEmailMessageAction } from '../../app/dashboard/journeys/[conversationId]/actions';

/** Sits next to a FAILED email message in the thread — resends its exact stored content. */
export function ResendMessageButton({
  conversationId,
  outboundMessageId,
}: {
  conversationId: string;
  outboundMessageId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ delivered: boolean; message: string } | null>(null);

  if (result?.delivered) {
    return <p className="mt-1 text-xs text-success">{result.message}</p>;
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setResult(await resendEmailMessageAction(conversationId, outboundMessageId));
          })
        }
        className="rounded-pill border border-danger/40 px-3 py-1 text-xs font-medium uppercase tracking-wide text-danger transition-colors duration-150 hover:bg-danger/10 disabled:opacity-60"
      >
        {pending ? 'Resending…' : 'Not delivered — resend'}
      </button>
      {result && !result.delivered && (
        <p className="text-xs text-danger" role="status">
          {result.message}
        </p>
      )}
    </div>
  );
}
