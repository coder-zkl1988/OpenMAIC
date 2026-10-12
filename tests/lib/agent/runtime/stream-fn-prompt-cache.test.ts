import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn() }));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));

import {
  applyPromptCaching,
  createCallLlmStreamFn,
  isAnthropicClaudeModel,
} from '@/lib/agent/runtime/stream-fn';
import { PI_PROMPT_CACHE_OPTIONS, PROMPT_CACHE_BREAK } from '@/lib/chat/pi/prompt-cache';

const claude = { provider: 'anthropic.messages', modelId: 'claude-sonnet-4-5' } as never;
const minimax = { provider: 'anthropic.messages', modelId: 'MiniMax-M3' } as never;
const openai = { provider: 'openai.chat', modelId: 'gpt-5' } as never;
const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' } } };
const system = `RULES${PROMPT_CACHE_BREAK}OUTLINE${PROMPT_CACHE_BREAK}STATE`;
const messages: ModelMessage[] = [
  { role: 'user', content: 'question' },
  { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
  { role: 'user', content: 'follow-up' },
];

describe('prompt caching in the stream adapter (I27)', () => {
  it('recognises Claude on the Anthropic API only', () => {
    expect(isAnthropicClaudeModel(claude)).toBe(true);
    expect(isAnthropicClaudeModel(minimax)).toBe(false);
    expect(isAnthropicClaudeModel(openai)).toBe(false);
    expect(isAnthropicClaudeModel('anthropic:claude' as never)).toBe(false);
  });

  it('marks the stable system segments and the newest message on Claude', () => {
    const prompt = applyPromptCaching(system, messages, {
      languageModel: claude,
      ...PI_PROMPT_CACHE_OPTIONS,
    });

    expect(prompt.system).toEqual([
      { role: 'system', content: 'RULES', providerOptions: EPHEMERAL },
      { role: 'system', content: 'OUTLINE', providerOptions: EPHEMERAL },
      { role: 'system', content: 'STATE' },
    ]);
    expect(prompt.messages.slice(0, -1)).toEqual(messages.slice(0, -1));
    expect(prompt.messages.at(-1)).toEqual({ ...messages[2], providerOptions: EPHEMERAL });
    // The input is not mutated
    expect(messages[2]).not.toHaveProperty('providerOptions');
  });

  it('caches a prompt without a break as one block, and drops empty segments', () => {
    expect(
      applyPromptCaching('ONLY', [], { languageModel: claude, ...PI_PROMPT_CACHE_OPTIONS }).system,
    ).toEqual([{ role: 'system', content: 'ONLY', providerOptions: EPHEMERAL }]);
    expect(
      applyPromptCaching(`A${PROMPT_CACHE_BREAK}\n${PROMPT_CACHE_BREAK}B`, [], {
        languageModel: claude,
        ...PI_PROMPT_CACHE_OPTIONS,
      }).system,
    ).toEqual([
      { role: 'system', content: 'A', providerOptions: EPHEMERAL },
      { role: 'system', content: 'B' },
    ]);
  });

  it('keeps within four breakpoints', () => {
    const many = Array.from({ length: 7 }, (_, index) => `S${index}`).join(PROMPT_CACHE_BREAK);
    const prompt = applyPromptCaching(many, messages, {
      languageModel: claude,
      ...PI_PROMPT_CACHE_OPTIONS,
    });
    const cached = (prompt.system as Array<{ providerOptions?: unknown }>).filter(
      (block) => block.providerOptions,
    );
    expect(cached).toHaveLength(3);
    expect(prompt.messages.at(-1)).toHaveProperty('providerOptions');
  });

  it('only removes the marker for other models, or without promptCaching', () => {
    for (const opts of [
      { languageModel: openai, ...PI_PROMPT_CACHE_OPTIONS },
      { languageModel: minimax, ...PI_PROMPT_CACHE_OPTIONS },
      { languageModel: claude, systemPromptSegmentBreak: PROMPT_CACHE_BREAK },
    ]) {
      const prompt = applyPromptCaching(system, messages, opts);
      expect(prompt.system).toBe('RULESOUTLINESTATE');
      expect(prompt.messages).toBe(messages);
    }
    // Without a declared break nothing is split
    expect(applyPromptCaching('A|B', [], { languageModel: openai }).system).toBe('A|B');
  });

  describe('through createCallLlmStreamFn', () => {
    beforeEach(() => {
      mocks.streamLLM.mockReset();
      mocks.streamLLM.mockReturnValue({
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'ok' };
          yield { type: 'finish', finishReason: 'stop', totalUsage: {} };
        })(),
      });
    });

    it('sends cache breakpoints to Claude', async () => {
      const streamFn = createCallLlmStreamFn({ languageModel: claude, ...PI_PROMPT_CACHE_OPTIONS });
      const stream = await streamFn(
        {} as never,
        {
          systemPrompt: system,
          messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
          tools: [],
        },
        {},
      );
      await stream.result();

      const params = mocks.streamLLM.mock.calls[0]?.[0];
      expect(params.system).toHaveLength(3);
      expect(params.messages.at(-1)).toMatchObject({ providerOptions: EPHEMERAL });
    });

    it('sends a plain string without the marker to other models', async () => {
      const streamFn = createCallLlmStreamFn({ languageModel: openai, ...PI_PROMPT_CACHE_OPTIONS });
      const stream = await streamFn(
        {} as never,
        { systemPrompt: system, messages: [], tools: [] },
        {},
      );
      await stream.result();

      expect(mocks.streamLLM.mock.calls[0]?.[0].system).toBe('RULESOUTLINESTATE');
    });
  });
});
