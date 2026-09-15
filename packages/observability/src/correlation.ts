import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface CorrelationContext {
  requestId: string;
  tenantId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function runWithCorrelation<T>(context: CorrelationContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getCorrelationContext(): CorrelationContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Uses an inbound `x-request-id` if present (and shaped like an id), otherwise mints one. */
export function resolveRequestId(inboundHeader: string | string[] | undefined): string {
  const value = Array.isArray(inboundHeader) ? inboundHeader[0] : inboundHeader;
  if (value && /^[a-zA-Z0-9._-]{1,128}$/.test(value)) {
    return value;
  }
  return randomUUID();
}
