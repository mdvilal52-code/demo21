import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface BootstrapObservabilityOptions {
  serviceName: string;
  otlpEndpoint: string | undefined;
}

export type ObservabilityStatus = 'CONFIGURED' | 'NOT_CONFIGURED';

export interface ObservabilityHandle {
  status: ObservabilityStatus;
  shutdown: () => Promise<void>;
}

/**
 * Starts tracing only when an OTLP endpoint is configured. With no endpoint
 * this is a deliberate NOT_CONFIGURED no-op rather than a fake exporter —
 * the same convention every external provider in this project follows.
 */
export function bootstrapObservability(
  options: BootstrapObservabilityOptions,
): ObservabilityHandle {
  if (!options.otlpEndpoint) {
    return { status: 'NOT_CONFIGURED', shutdown: async () => {} };
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName }),
    traceExporter: new OTLPTraceExporter({ url: options.otlpEndpoint }),
    instrumentations: [new HttpInstrumentation()],
  });

  sdk.start();

  return {
    status: 'CONFIGURED',
    shutdown: () => sdk.shutdown(),
  };
}
