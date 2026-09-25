import type { UserRoleValue } from '@ai-concierge/domain';

/**
 * MASTER-PLAN.md §1 "AI Orchestrator … tool calls behind permission gates"
 * and §4's journey states: "each tool declares allowed journey states and
 * roles; side-effecting tools execute only through the workflow engine."
 *
 * No AIProvider adapter actually performs LLM tool-calling yet (Steps 1-4
 * all run on deterministic/rule-based engines — see packages/ai/src/provider.ts's
 * own doc comment), so there is nothing real to wire this into today. This
 * is the seam itself: a pure, tested policy function ready for the
 * tool-calling loop a future phase adds, matching how `AIProvider` and
 * `IdentityProvider` (packages/security) exist ahead of their first real
 * adapter rather than being invented under deadline pressure then.
 */
export interface ToolDefinition {
  name: string;
  /** Journey states (MASTER-PLAN.md §4's `state` column) this tool may be invoked from. */
  allowedJourneyStates: readonly string[];
  /** Roles that may approve/trigger this tool when a human is in the loop (e.g. Step 13 AWAITING_HUMAN_APPROVAL). Irrelevant for a tool the AI calls autonomously within an allowed state. */
  allowedRoles: readonly UserRoleValue[];
  /** Side-effecting tools must run through the workflow engine, never a direct AI-initiated call — MASTER-PLAN.md §1. */
  sideEffecting: boolean;
}

export interface ToolInvocationContext {
  journeyState: string;
  role?: UserRoleValue;
}

export type ToolDenialReason =
  'JOURNEY_STATE_NOT_ALLOWED' | 'ROLE_NOT_ALLOWED' | 'REQUIRES_WORKFLOW_ENGINE';

export type ToolAuthorizationDecision =
  { allowed: true } | { allowed: false; reason: ToolDenialReason };

export function authorizeToolInvocation(
  tool: ToolDefinition,
  context: ToolInvocationContext,
): ToolAuthorizationDecision {
  if (!tool.allowedJourneyStates.includes(context.journeyState)) {
    return { allowed: false, reason: 'JOURNEY_STATE_NOT_ALLOWED' };
  }
  if (tool.sideEffecting && !context.role) {
    // A side-effecting tool with no human role in context is being invoked
    // directly by the AI outside the workflow engine's approval path —
    // exactly what MASTER-PLAN.md §1 forbids.
    return { allowed: false, reason: 'REQUIRES_WORKFLOW_ENGINE' };
  }
  if (context.role && !tool.allowedRoles.includes(context.role)) {
    return { allowed: false, reason: 'ROLE_NOT_ALLOWED' };
  }
  return { allowed: true };
}
