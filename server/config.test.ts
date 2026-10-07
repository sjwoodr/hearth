import { afterEach, describe, expect, it, vi } from 'vitest';

// config.ts reads the environment once, on import, so each case stubs it and imports a fresh copy.
// Stubbed values win over .env, which never overwrites what is already set.
async function loadConfig(vars: Record<string, string>) {
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  vi.resetModules();
  return (await import('./config.ts')).config;
}

afterEach(() => vi.unstubAllEnvs());

describe('context window and budget', () => {
  it('keeps the window and the part hearth fills apart', async () => {
    const config = await loadConfig({ HEARTH_NUM_CTX: '32768', HEARTH_CONTEXT_BUDGET: '16384' });
    expect(config.numCtx).toBe(32768);
    expect(config.contextBudget).toBe(16384);
  });

  it('never lets the budget exceed the window', async () => {
    const config = await loadConfig({ HEARTH_NUM_CTX: '8192', HEARTH_CONTEXT_BUDGET: '16384' });
    expect(config.contextBudget).toBe(8192);
  });
});
