import { describe, it, expect, vi, afterEach } from 'vitest';
import { generate, GeminiTruncatedError } from './gemini';

// This file exists because of a production bug that looked like bad
// source data and was not.
//
// Gemini 2.5 counts THINKING tokens against maxOutputTokens, and by
// default it will spend 90-98% of the budget reasoning. Every call site
// asked for 200-900 tokens, so the model thought through nearly all of
// it and emitted a fragment — cut mid-sentence, one post where four
// were requested:
//
//   "Cambuur vs Excelsior (BTTS): will both"
//   "BBN is back and the TL is wild. ... The chatter? It"
//
// Two things must therefore stay true, and both are asserted here:
// thinking is disabled on every request, and a MAX_TOKENS finish is an
// error rather than a fragment we quietly publish.

const OLD_KEY = process.env.GEMINI_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  if (OLD_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = OLD_KEY;
});

function mockGemini(body: unknown, ok = true) {
  const spy = vi.fn(async (_url: string, _init?: any) => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const reply = (text: string, finishReason = 'STOP') => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason }],
});

describe('generate', () => {
  it('disables thinking on every request', async () => {
    process.env.GEMINI_API_KEY = 'k';
    const spy = mockGemini(reply('a post'));

    await generate('write something');

    const body = JSON.parse((spy.mock.calls[0]![1] as any).body);
    // The whole fix. Without this the model spends the budget reasoning
    // and returns half a sentence.
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('throws on MAX_TOKENS rather than returning a fragment', async () => {
    process.env.GEMINI_API_KEY = 'k';
    mockGemini(reply('BBN is back and the TL is wild. The chatter? It', 'MAX_TOKENS'));

    await expect(generate('x')).rejects.toBeInstanceOf(GeminiTruncatedError);
  });

  it('exposes the partial text so a caller can salvage whole posts', async () => {
    process.env.GEMINI_API_KEY = 'k';
    mockGemini(reply('1. Complete post.\n2. Half a p', 'MAX_TOKENS'));

    try {
      await generate('x');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GeminiTruncatedError);
      expect((e as GeminiTruncatedError).partial).toContain('Complete post.');
    }
  });

  it('returns text on a normal finish', async () => {
    process.env.GEMINI_API_KEY = 'k';
    mockGemini(reply('Arsenal at 47% and it has not moved.'));
    await expect(generate('x')).resolves.toBe('Arsenal at 47% and it has not moved.');
  });

  it('names the finishReason when the model declines', async () => {
    process.env.GEMINI_API_KEY = 'k';
    mockGemini({ candidates: [{ finishReason: 'SAFETY' }] });
    await expect(generate('x')).rejects.toThrow(/SAFETY/);
  });

  it('fails clearly with no API key', async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(generate('x')).rejects.toThrow(/GEMINI_API_KEY/);
  });

  it('passes through the requested temperature and token budget', async () => {
    process.env.GEMINI_API_KEY = 'k';
    const spy = mockGemini(reply('ok'));

    await generate('x', { temperature: 0.4, maxOutputTokens: 777 });

    const body = JSON.parse((spy.mock.calls[0]![1] as any).body);
    expect(body.generationConfig.temperature).toBe(0.4);
    expect(body.generationConfig.maxOutputTokens).toBe(777);
  });
});
