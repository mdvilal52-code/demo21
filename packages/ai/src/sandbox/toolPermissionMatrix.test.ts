import { describe, expect, it } from 'vitest';
import { UserRole } from '@ai-concierge/domain';
import { authorizeToolInvocation, type ToolDefinition } from './toolPermissionMatrix.js';

const readOnlyAiTool: ToolDefinition = {
  name: 'quote.explain',
  allowedJourneyStates: ['QUOTE_ISSUED'],
  allowedRoles: [],
  sideEffecting: false,
};

const sideEffectingTool: ToolDefinition = {
  name: 'booking.confirm',
  allowedJourneyStates: ['AWAITING_HUMAN_APPROVAL'],
  allowedRoles: [UserRole.MANAGER, UserRole.ADMIN],
  sideEffecting: true,
};

describe('authorizeToolInvocation', () => {
  it('allows a read-only tool the AI calls directly within its allowed state', () => {
    const decision = authorizeToolInvocation(readOnlyAiTool, { journeyState: 'QUOTE_ISSUED' });
    expect(decision).toEqual({ allowed: true });
  });

  it('denies a tool invoked from a journey state it is not scoped to', () => {
    const decision = authorizeToolInvocation(readOnlyAiTool, { journeyState: 'CONFIRMED' });
    expect(decision).toEqual({ allowed: false, reason: 'JOURNEY_STATE_NOT_ALLOWED' });
  });

  it('denies a side-effecting tool invoked with no human role in context (AI calling it directly, bypassing the workflow engine)', () => {
    const decision = authorizeToolInvocation(sideEffectingTool, {
      journeyState: 'AWAITING_HUMAN_APPROVAL',
    });
    expect(decision).toEqual({ allowed: false, reason: 'REQUIRES_WORKFLOW_ENGINE' });
  });

  it('allows a side-effecting tool approved by a permitted role in an allowed state', () => {
    const decision = authorizeToolInvocation(sideEffectingTool, {
      journeyState: 'AWAITING_HUMAN_APPROVAL',
      role: UserRole.MANAGER,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it('denies a side-effecting tool when the approving role is not permitted', () => {
    const decision = authorizeToolInvocation(sideEffectingTool, {
      journeyState: 'AWAITING_HUMAN_APPROVAL',
      role: UserRole.OPS_AGENT,
    });
    expect(decision).toEqual({ allowed: false, reason: 'ROLE_NOT_ALLOWED' });
  });

  it('journey-state check takes precedence over role checks', () => {
    const decision = authorizeToolInvocation(sideEffectingTool, {
      journeyState: 'CONFIRMED',
      role: UserRole.ADMIN,
    });
    expect(decision).toEqual({ allowed: false, reason: 'JOURNEY_STATE_NOT_ALLOWED' });
  });
});
