import { describe, expect, it } from 'vitest';
import type {
  AIProvider,
  AIProviderHealth,
  GenerateStructuredResult,
  GenerateWithToolsInput,
  GenerateWithToolsResult,
} from '../provider.js';
import { ConversationEngine } from './conversationEngine.js';
import { createInitialEngineState } from './types.js';
import type { EngineExecutionContext, EngineFunction } from './types.js';

const NOW = new Date('2026-09-28T00:00:00.000Z');

function execCtx(rawMessage: string): EngineExecutionContext {
  return { tenantId: 'tenant-1', conversationId: 'conv-1', rawMessage, now: NOW };
}

function fakeProvider(
  responses: GenerateWithToolsResult[],
): AIProvider & { calls: GenerateWithToolsInput[] } {
  const calls: GenerateWithToolsInput[] = [];
  let i = 0;
  return {
    name: 'fake',
    calls,
    async generateStructured(): Promise<GenerateStructuredResult> {
      throw new Error('not used in these tests');
    },
    async healthCheck(): Promise<AIProviderHealth> {
      return 'CONFIGURED';
    },
    async generateWithTools(input: GenerateWithToolsInput): Promise<GenerateWithToolsResult> {
      calls.push(input);
      const response = responses[Math.min(i, responses.length - 1)] ?? responses[0];
      i += 1;
      if (!response) throw new Error('no fake response configured');
      return response;
    },
  };
}

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

const echoFunction: EngineFunction = {
  declaration: {
    name: 'echo',
    description: 'Echoes back whatever text argument it is given.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  validateArgs(raw) {
    if (typeof raw.text !== 'string' || raw.text.trim().length === 0) {
      return { valid: false, reason: 'text is required' };
    }
    return { valid: true, args: { text: raw.text.trim() } };
  },
  async execute(args) {
    return { ok: true, data: { echoed: args.text }, message: `You said: ${String(args.text)}` };
  },
};

describe('ConversationEngine', () => {
  it('throws NOT_CONFIGURED when the provider has no generateWithTools', async () => {
    const provider: AIProvider = {
      name: 'no-tools',
      async generateStructured(): Promise<GenerateStructuredResult> {
        throw new Error('unused');
      },
      async healthCheck(): Promise<AIProviderHealth> {
        return 'CONFIGURED';
      },
    };
    const engine = new ConversationEngine({
      provider,
      functions: [echoFunction],
      systemInstruction: 'test',
    });
    await expect(
      engine.handleMessage([], 'hi', createInitialEngineState(), execCtx('hi')),
    ).rejects.toThrow(/does not support function calling/);
  });

  it('replies directly, with no function call, when the model answers in plain text', async () => {
    const provider = fakeProvider([
      { text: 'Hello! How can I help?', usage, modelId: 'test-model', latencyMs: 1 },
    ]);
    const engine = new ConversationEngine({
      provider,
      functions: [echoFunction],
      systemInstruction: 'test',
    });
    const result = await engine.handleMessage(
      [],
      'hi there',
      createInitialEngineState(),
      execCtx('hi there'),
    );
    expect(result.intent).toBeNull();
    expect(result.reply).toBe('Hello! How can I help?');
    expect(result.state.turnCount).toBe(1);
  });

  it('validates model-proposed args before executing the function ("never trust AI output")', async () => {
    const provider = fakeProvider([
      {
        functionCall: { name: 'echo', args: { text: '   ' } },
        usage,
        modelId: 'test-model',
        latencyMs: 1,
      },
    ]);
    const engine = new ConversationEngine({
      provider,
      functions: [echoFunction],
      systemInstruction: 'test',
    });
    const result = await engine.handleMessage(
      [],
      'say nothing',
      createInitialEngineState(),
      execCtx('say nothing'),
    );
    expect(result.reply).toMatch(/text is required/);
    expect(result.intent).toBe('echo');
  });

  it('executes the chosen function then grounds the reply in a second tool-aware call', async () => {
    const provider = fakeProvider([
      {
        functionCall: { name: 'echo', args: { text: 'parrot' } },
        usage,
        modelId: 'test-model',
        latencyMs: 1,
      },
      { text: 'The concierge repeated: parrot', usage, modelId: 'test-model', latencyMs: 1 },
    ]);
    const engine = new ConversationEngine({
      provider,
      functions: [echoFunction],
      systemInstruction: 'test',
    });
    const result = await engine.handleMessage(
      [],
      'say parrot',
      createInitialEngineState(),
      execCtx('say parrot'),
    );
    expect(result.intent).toBe('echo');
    expect(result.reply).toBe('The concierge repeated: parrot');
    expect(result.state.lastIntent).toBe('echo');
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.contents.at(-1)).toEqual({
      role: 'user',
      functionResponse: {
        name: 'echo',
        response: { ok: true, message: 'You said: parrot', echoed: 'parrot' },
      },
    });
  });

  it('falls back to the function\'s own message if the grounding call throws', async () => {
    const provider = fakeProvider([
      {
        functionCall: { name: 'echo', args: { text: 'parrot' } },
        usage,
        modelId: 'test-model',
        latencyMs: 1,
      },
    ]);
    provider.generateWithTools = async (input) => {
      provider.calls.push(input);
      if (provider.calls.length === 1) {
        return {
          functionCall: { name: 'echo', args: { text: 'parrot' } },
          usage,
          modelId: 'test-model',
          latencyMs: 1,
        };
      }
      throw new Error('upstream down');
    };
    const engine = new ConversationEngine({
      provider,
      functions: [echoFunction],
      systemInstruction: 'test',
    });
    const result = await engine.handleMessage(
      [],
      'say parrot',
      createInitialEngineState(),
      execCtx('say parrot'),
    );
    expect(result.reply).toBe('You said: parrot');
  });

  it('returns finalReply verbatim and skips the grounding call when a function sets it', async () => {
    const trustedFunction: EngineFunction = {
      declaration: {
        name: 'trusted',
        description: 'A function that already produced a customer-safe reply itself.',
        parameters: { type: 'object', properties: {} },
      },
      validateArgs: () => ({ valid: true, args: {} }),
      async execute() {
        return { ok: true, message: 'unused', finalReply: 'Already-worded, trusted reply.' };
      },
    };
    const provider = fakeProvider([
      { functionCall: { name: 'trusted', args: {} }, usage, modelId: 'test-model', latencyMs: 1 },
    ]);
    const engine = new ConversationEngine({
      provider,
      functions: [trustedFunction],
      systemInstruction: 'test',
    });
    const result = await engine.handleMessage(
      [],
      'anything',
      createInitialEngineState(),
      execCtx('anything'),
    );
    expect(result.reply).toBe('Already-worded, trusted reply.');
    expect(provider.calls).toHaveLength(1);
  });

  it('replies with a generic decline when the model names an unknown function', async () => {
    const provider = fakeProvider([
      {
        functionCall: { name: 'not_a_real_function', args: {} },
        usage,
        modelId: 'test-model',
        latencyMs: 1,
      },
    ]);
    const engine = new ConversationEngine({
      provider,
      functions: [echoFunction],
      systemInstruction: 'test',
    });
    const result = await engine.handleMessage(
      [],
      'do something else',
      createInitialEngineState(),
      execCtx('do something else'),
    );
    expect(result.intent).toBeNull();
    expect(result.reply).toMatch(/not able to help/);
  });
});
