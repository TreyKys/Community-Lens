import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '111';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

function mockResponses(...responses: Array<{ status: number; body: any }>) {
  let i = 0;
  const spy = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

// notify() is the simplest path through tg() — good enough to exercise
// the retry logic without needing every send* variant.
async function callNotify(text = 'hi') {
  const { notify } = await import('./telegram');
  return notify(text);
}

describe('tg() retry behaviour', () => {
  it('succeeds on the first try with no retry', async () => {
    const spy = mockResponses({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    await callNotify();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 after the exact retry_after Telegram names', async () => {
    const spy = mockResponses(
      { status: 429, body: { ok: false, parameters: { retry_after: 3 } } },
      { status: 200, body: { ok: true, result: { message_id: 1 } } },
    );

    const p = callNotify();
    // Nothing has happened yet — still inside the wait.
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(600); // the +0.5s margin
    await p;

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx with a short backoff', async () => {
    const spy = mockResponses(
      { status: 500, body: { ok: false, description: 'boom' } },
      { status: 200, body: { ok: true, result: { message_id: 1 } } },
    );

    const p = callNotify();
    await vi.advanceTimersByTimeAsync(1500);
    await p;

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 attempts and throws the last error', async () => {
    const spy = mockResponses({ status: 500, body: { ok: false, description: 'still down' } });

    // .catch attached synchronously, before any timer advances — with
    // fake timers, attaching the assertion after advancing leaves a
    // brief window where the rejection has no listener yet.
    let caught: Error | undefined;
    const p = callNotify().catch((e) => { caught = e; });
    await vi.advanceTimersByTimeAsync(10_000);
    await p;

    expect(caught?.message).toMatch(/500/);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a genuine bad request — wrong token fails once', async () => {
    // 401/403/400 will fail identically every time; retrying only adds
    // delay before the caller finds out.
    const spy = mockResponses({ status: 401, body: { ok: false, description: 'Unauthorized' } });

    await expect(callNotify()).rejects.toThrow(/401/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retries a network-level failure (fetch itself throwing)', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls === 1) throw new TypeError('network down');
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) } as Response;
    }));

    const p = callNotify();
    await vi.advanceTimersByTimeAsync(1500);
    await p;

    expect(calls).toBe(2);
  });
});

describe('allowedUserIds / isAllowedUser', () => {
  it('falls back to TELEGRAM_CHAT_ID when no allow-list is set — unchanged behaviour for a private chat', async () => {
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    process.env.TELEGRAM_CHAT_ID = '555';
    const { isAllowedUser } = await import('./telegram');
    expect(isAllowedUser('555')).toBe(true);
    expect(isAllowedUser('999')).toBe(false);
  });

  it('uses the explicit allow-list once TELEGRAM_CHAT_ID has become a group id', async () => {
    // A group's chat id is not anyone's user id — this is the exact
    // scenario that makes the fallback insufficient.
    process.env.TELEGRAM_CHAT_ID = '-1009988776655';
    process.env.TELEGRAM_ALLOWED_USER_IDS = '111,222';
    const { isAllowedUser } = await import('./telegram');
    expect(isAllowedUser('111')).toBe(true);
    expect(isAllowedUser('222')).toBe(true);
    expect(isAllowedUser('-1009988776655')).toBe(false);
    expect(isAllowedUser('333')).toBe(false);
  });

  it('trims whitespace in a comma list typed by hand', async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = ' 111 , 222 ';
    const { isAllowedUser } = await import('./telegram');
    expect(isAllowedUser('111')).toBe(true);
    expect(isAllowedUser('222')).toBe(true);
  });

  it('rejects an empty or missing id outright, never by accidentally matching an empty allow-list entry', async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = '111,,222';
    const { isAllowedUser } = await import('./telegram');
    expect(isAllowedUser('')).toBe(false);
    expect(isAllowedUser(undefined)).toBe(false);
    expect(isAllowedUser(null)).toBe(false);
  });
});

describe('notifyOrEscalate', () => {
  it('sends via Telegram and never touches email when Telegram works', async () => {
    mockResponses({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    const emailSpy = vi.fn();
    vi.doMock('@/lib/ops-email', () => ({ sendOpsEmail: emailSpy }));

    const { notifyOrEscalate } = await import('./telegram');
    await notifyOrEscalate('all fine', 'subject');

    expect(emailSpy).not.toHaveBeenCalled();
    vi.doUnmock('@/lib/ops-email');
  });

  it('falls back to email once Telegram exhausts its own retries', async () => {
    mockResponses({ status: 500, body: { ok: false } });
    const emailSpy = vi.fn(async (_args: { subject: string; html: string }) => {});
    vi.doMock('@/lib/ops-email', () => ({ sendOpsEmail: emailSpy }));

    const { notifyOrEscalate } = await import('./telegram');
    const p = notifyOrEscalate('digest run failed', 'Social bot alert');
    await vi.advanceTimersByTimeAsync(10_000);
    await p;

    expect(emailSpy).toHaveBeenCalledTimes(1);
    const call = emailSpy.mock.calls[0]![0];
    expect(call.subject).toBe('Social bot alert');
    expect(call.html).toContain('digest run failed');
    vi.doUnmock('@/lib/ops-email');
  });
});
