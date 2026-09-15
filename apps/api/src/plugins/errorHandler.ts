import { AppError, isAppError } from '@ai-concierge/domain';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import type { FastifyError, FastifyInstance } from 'fastify';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request failed schema validation',
          details: { issues: error.validation },
        },
      });
      return;
    }

    if (isAppError(error)) {
      request.log.warn({ code: error.code, err: error.message }, 'application error');
      reply.status(error.httpStatus).send(error.toJSON());
      return;
    }

    if (error.statusCode && error.statusCode < 500) {
      reply.status(error.statusCode).send({
        error: { code: 'VALIDATION_FAILED', message: error.message },
      });
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    const internal = new AppError('INTERNAL', 'An unexpected error occurred', { cause: error });
    reply.status(internal.httpStatus).send(internal.toJSON());
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    });
  });
}
