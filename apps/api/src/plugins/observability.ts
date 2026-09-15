import { getRequestId, resolveRequestId, runWithCorrelation } from '@ai-concierge/observability';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Assigns/propagates a request id, runs the rest of the request inside an
 * AsyncLocalStorage correlation context, and logs start/finish with timing.
 * Registered as a plugin (not a bare hook) so `fastify-plugin` skips
 * encapsulation and every route sees the same request id on `reply` headers.
 */
export const observabilityPlugin = fp(async function observabilityPlugin(app: FastifyInstance) {
  app.addHook('onRequest', (request, reply, done) => {
    const requestId = resolveRequestId(request.headers['x-request-id']);
    reply.header('x-request-id', requestId);
    runWithCorrelation({ requestId }, () => {
      request.log = request.log.child({ requestId });
      done();
    });
  });

  app.addHook('onResponse', (request, reply, done) => {
    request.log.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
        requestId: getRequestId(),
      },
      'request completed',
    );
    done();
  });
});
