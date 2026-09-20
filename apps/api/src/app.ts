import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
} from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { AppContext } from './context.js';
import { registerSecurityPlugins } from './plugins/security.js';
import { observabilityPlugin } from './plugins/observability.js';
import { registerSwagger } from './plugins/swagger.js';
import { registerErrorHandler } from './plugins/errorHandler.js';
import { healthRoutes } from './routes/health.js';
import { enquiryRoutes } from './routes/v1/enquiries.js';
import { temporalRoutes } from './routes/v1/temporal.js';
import { vehicleRoutes } from './routes/v1/vehicle.js';
import { missingInfoRoutes } from './routes/v1/missingInfo.js';
import { whatsappWebhookRoutes } from './routes/webhooks/whatsapp.js';

export async function buildApp(
  ctx: AppContext,
  logger: FastifyBaseLogger,
): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: ctx.config.API_BODY_LIMIT_BYTES,
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: 'x-request-id',
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('ctx', ctx);

  await registerSecurityPlugins(app, ctx.config);
  await app.register(observabilityPlugin);
  await registerSwagger(app, ctx.config);
  registerErrorHandler(app);

  await app.register(healthRoutes);
  await app.register(enquiryRoutes);
  await app.register(temporalRoutes);
  await app.register(vehicleRoutes);
  await app.register(missingInfoRoutes);
  await app.register(whatsappWebhookRoutes);

  return app;
}
