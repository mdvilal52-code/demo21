'use client';

import type { ChatMessage, GetChatSessionResponse } from '@ai-concierge/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'ai-concierge-chat-session';
const POLL_MS = 6_000;
/**
 * Waits before each automatic re-send of the SAME message id. Safe by construction: the server
 * replays a stored reply for a repeated id, or answers 409 while the first attempt is still running,
 * so a retry can never make the concierge answer twice.
 */
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];
const RETRYABLE_STATUSES = new Set([409, 502, 503, 504]);

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** A message the customer typed that the server has not confirmed yet (or that failed and can be retried safely). */
export interface PendingMessage {
  clientMessageId: string;
  text: string;
  failed: boolean;
  error: string | null;
}

type Status = 'loading' | 'ready' | 'offline';

function readSessionId(): string {
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
  } catch {
    // Storage blocked (private mode): fall through to a per-tab id.
  }
  const created = crypto.randomUUID();
  try {
    window.localStorage.setItem(STORAGE_KEY, created);
  } catch {
    // Nothing to do: the chat still works for this tab.
  }
  return created;
}

/**
 * All the state behind the customer chat. The customer is identified by a
 * random session id kept in this browser; the thread itself lives on the
 * server, so it survives a reload, another tab, and a team member's reply
 * appearing while the page is open (polled while visible).
 *
 * Each outgoing message carries its own `clientMessageId`, so a retry after a
 * flaky connection can never make the concierge answer the same message twice.
 */
export function useChatSession() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<GetChatSessionResponse | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  useEffect(() => {
    setSessionId(readSessionId());
  }, []);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const response = await fetch(`/api/chat/sessions/${sessionId}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      setSession((await response.json()) as GetChatSessionResponse);
      setStatus('ready');
    } catch {
      setStatus('offline');
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !sendingRef.current) void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [sessionId, refresh]);

  const transmit = useCallback(
    async (item: PendingMessage) => {
      if (!sessionId) return;
      sendingRef.current = true;
      setSending(true);
      setPending((list) =>
        list.map((entry) =>
          entry.clientMessageId === item.clientMessageId
            ? { ...entry, failed: false, error: null }
            : entry,
        ),
      );
      const fail = (message: string) =>
        setPending((list) =>
          list.map((entry) =>
            entry.clientMessageId === item.clientMessageId
              ? { ...entry, failed: true, error: message }
              : entry,
          ),
        );

      try {
        for (let attempt = 0; ; attempt += 1) {
          let response: Response | null = null;
          try {
            response = await fetch('/api/chat/messages', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                sessionId,
                clientMessageId: item.clientMessageId,
                message: item.text,
              }),
            });
          } catch {
            response = null; // offline / connection dropped
          }

          if (response?.ok) {
            setPending((list) =>
              list.filter((entry) => entry.clientMessageId !== item.clientMessageId),
            );
            await refresh();
            return;
          }

          const retryable = response === null || RETRYABLE_STATUSES.has(response.status);
          const delay = RETRY_DELAYS_MS[attempt];
          if (retryable && delay !== undefined) {
            await sleep(delay);
            continue;
          }

          if (response === null) {
            fail('You appear to be offline.');
          } else {
            const payload: unknown = await response.json().catch(() => null);
            fail(
              (payload as { error?: { message?: string } } | null)?.error?.message ??
                'Something went wrong.',
            );
          }
          // The server may have finished the turn even though this request timed out: show its state.
          void refresh();
          return;
        }
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [sessionId, refresh],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !sessionId) return;
      const item: PendingMessage = {
        clientMessageId: crypto.randomUUID(),
        text: trimmed,
        failed: false,
        error: null,
      };
      setPending((list) => [...list, item]);
      void transmit(item);
    },
    [sessionId, transmit],
  );

  const retry = useCallback(
    (clientMessageId: string) => {
      const item = pending.find((entry) => entry.clientMessageId === clientMessageId);
      if (item) void transmit(item);
    },
    [pending, transmit],
  );

  /** Forget this browser's conversation and begin a fresh one (the old one stays with the team). */
  const startNew = useCallback(() => {
    const created = crypto.randomUUID();
    try {
      window.localStorage.setItem(STORAGE_KEY, created);
    } catch {
      // ignore: the new id still applies for this tab
    }
    setPending([]);
    setSession(null);
    setStatus('loading');
    setSessionId(created);
  }, []);

  const messages: ChatMessage[] = session?.messages ?? [];

  return {
    ready: sessionId !== null,
    status,
    session,
    messages,
    pending,
    sending,
    send,
    retry,
    startNew,
    refresh,
  };
}
