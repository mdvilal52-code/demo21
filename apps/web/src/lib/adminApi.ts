import 'server-only';
import {
  errorResponseSchema,
  escalationCaseResponseSchema,
  getCustomerResponseSchema,
  getJourneyResponseSchema,
  listCustomersResponseSchema,
  listEscalationsResponseSchema,
  listJourneysResponseSchema,
  listVehiclesResponseSchema,
  providerStatusResponseSchema,
  type EscalationCaseResponse,
  type GetCustomerResponse,
  type GetJourneyResponse,
  type ListCustomersResponse,
  type ListEscalationsResponse,
  type ListJourneysResponse,
  type ListVehiclesResponse,
  type ProviderStatusResponse,
} from '@ai-concierge/contracts';
import type { z } from 'zod';
import { backendFetch } from './backendFetch';
import { readTokensFromCookieStore } from './session';

/**
 * Thrown by every `adminApi` call when there is no usable access token, or
 * the API rejects it as expired/revoked. Every dashboard page catches this
 * one type and redirects to `/login` — any other error is a real upstream
 * problem and is left to bubble into the route's `error.tsx`.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired or not signed in');
    this.name = 'SessionExpiredError';
  }
}

async function adminGet<Schema extends z.ZodTypeAny>(
  path: string,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const { accessToken } = await readTokensFromCookieStore();
  if (!accessToken) throw new SessionExpiredError();

  const upstream = await backendFetch(path, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (upstream.status === 401) throw new SessionExpiredError();
  if (!upstream.ok) {
    throw new Error(`Admin API request to ${path} failed with status ${upstream.status}`);
  }
  return schema.parse(await upstream.json());
}

async function adminPost<Schema extends z.ZodTypeAny>(
  path: string,
  body: unknown,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const { accessToken } = await readTokensFromCookieStore();
  if (!accessToken) throw new SessionExpiredError();

  const upstream = await backendFetch(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (upstream.status === 401) throw new SessionExpiredError();
  if (!upstream.ok) {
    const parsedError = errorResponseSchema.safeParse(await upstream.json().catch(() => null));
    throw new Error(
      parsedError.success
        ? parsedError.data.error.message
        : `Request failed with status ${upstream.status}`,
    );
  }
  return schema.parse(await upstream.json());
}

function toQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export function fetchJourneys(params: {
  state?: string;
  limit?: number;
  offset?: number;
}): Promise<ListJourneysResponse> {
  return adminGet(`/v1/journeys${toQueryString(params)}`, listJourneysResponseSchema);
}

export function fetchJourneyDetail(conversationId: string): Promise<GetJourneyResponse> {
  return adminGet(
    `/v1/enquiries/${encodeURIComponent(conversationId)}/journey`,
    getJourneyResponseSchema,
  );
}

export function fetchVehicles(params: {
  limit?: number;
  offset?: number;
}): Promise<ListVehiclesResponse> {
  return adminGet(`/v1/vehicles${toQueryString(params)}`, listVehiclesResponseSchema);
}

export function fetchCustomers(params: {
  limit?: number;
  offset?: number;
}): Promise<ListCustomersResponse> {
  return adminGet(`/v1/customers${toQueryString(params)}`, listCustomersResponseSchema);
}

export function fetchCustomerDetail(customerId: string): Promise<GetCustomerResponse> {
  return adminGet(`/v1/customers/${encodeURIComponent(customerId)}`, getCustomerResponseSchema);
}

export function fetchEscalations(params: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<ListEscalationsResponse> {
  return adminGet(`/v1/escalations${toQueryString(params)}`, listEscalationsResponseSchema);
}

export function fetchProviderStatus(): Promise<ProviderStatusResponse> {
  return adminGet('/v1/settings/providers', providerStatusResponseSchema);
}

export function assignEscalation(escalationCaseId: string): Promise<EscalationCaseResponse> {
  return adminPost(
    `/v1/escalations/${encodeURIComponent(escalationCaseId)}/assign`,
    {},
    escalationCaseResponseSchema,
  );
}

export function resolveEscalation(
  escalationCaseId: string,
  body: { resolution: 'APPROVED' | 'REJECTED'; resolutionNote: string },
): Promise<EscalationCaseResponse> {
  return adminPost(
    `/v1/escalations/${encodeURIComponent(escalationCaseId)}/resolve`,
    body,
    escalationCaseResponseSchema,
  );
}
