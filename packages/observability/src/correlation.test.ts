import { describe, expect, it } from 'vitest';
import {
  getCorrelationContext,
  getRequestId,
  resolveRequestId,
  runWithCorrelation,
} from './correlation.js';

describe('correlation context', () => {
  it('is undefined outside of runWithCorrelation', () => {
    expect(getCorrelationContext()).toBeUndefined();
    expect(getRequestId()).toBeUndefined();
  });

  it('is available inside runWithCorrelation', () => {
    runWithCorrelation({ requestId: 'req-1', tenantId: 'tenant-1' }, () => {
      expect(getRequestId()).toBe('req-1');
      expect(getCorrelationContext()).toEqual({ requestId: 'req-1', tenantId: 'tenant-1' });
    });
  });

  it('isolates concurrent async contexts', async () => {
    const results: string[] = [];
    await Promise.all([
      runWithCorrelation({ requestId: 'a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push(getRequestId()!);
      }),
      runWithCorrelation({ requestId: 'b' }, async () => {
        results.push(getRequestId()!);
      }),
    ]);
    expect(results.sort()).toEqual(['a', 'b']);
  });
});

describe('resolveRequestId', () => {
  it('reuses a well-formed inbound header', () => {
    expect(resolveRequestId('client-supplied-id-123')).toBe('client-supplied-id-123');
  });

  it('mints a new id when the header is missing', () => {
    const id = resolveRequestId(undefined);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mints a new id when the header contains unsafe characters', () => {
    const id = resolveRequestId('<script>alert(1)</script>');
    expect(id).not.toContain('<script>');
  });

  it('takes the first value when the header is duplicated', () => {
    expect(resolveRequestId(['first-id', 'second-id'])).toBe('first-id');
  });
});
