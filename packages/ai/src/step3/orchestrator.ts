import type { VehicleDeterminationResult } from '@ai-concierge/domain';
import { sanitizeForProcessing } from '../sanitize.js';
import type { VehicleCatalogProvider } from './vehicleCatalogProvider.js';
import { VehicleCatalogService } from './vehicleCatalogService.js';
import { VehicleIntentService } from './vehicleIntentService.js';
import { VehicleValidationService } from './vehicleValidationService.js';

export interface VehicleDeterminationOrchestratorOptions {
  catalogProvider: VehicleCatalogProvider;
}

export interface DetermineVehicleOptions {
  tenantId: string;
}

/**
 * Step 3 — Determine Vehicle. Wires the AI-side proposal service
 * (`VehicleIntentService`) to the real fleet (`VehicleCatalogService`) and
 * the deterministic verifier (`VehicleValidationService`), matching Steps
 * 1-2's rule: AI proposes, deterministic domain logic verifies. Unlike
 * Step 2's static Dubai/UAE gazetteer, there is no sensible zero-config
 * default catalog — a real, tenant-scoped `VehicleCatalogProvider` is
 * required.
 */
export class VehicleDeterminationOrchestrator {
  private readonly intentService = new VehicleIntentService();
  private readonly validationService = new VehicleValidationService();
  private readonly catalogService: VehicleCatalogService;

  constructor(options: VehicleDeterminationOrchestratorOptions) {
    this.catalogService = new VehicleCatalogService(options.catalogProvider);
  }

  async determine(
    rawMessage: string,
    options: DetermineVehicleOptions,
  ): Promise<VehicleDeterminationResult> {
    const { promptInjectionDetected, sanitizedText } = sanitizeForProcessing(rawMessage);

    const lexicon = await this.catalogService.getLexicon(options.tenantId);
    const proposal = this.intentService.propose(sanitizedText, lexicon);
    const lookup = await this.catalogService.resolve(options.tenantId, proposal);

    return this.validationService.validate({ proposal, lookup, promptInjectionDetected });
  }
}
