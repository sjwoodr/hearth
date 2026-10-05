// Its own file, so its registry has seen no other test's counts: a series found here can only
// have come from zeroCounters.
import { describe, expect, it } from 'vitest';
import { registry, searches, watchOllama, zeroCounters } from './metrics.ts';

async function value(name: string, labels: Record<string, string> = {}): Promise<number> {
  const { values } = await registry.getSingleMetric(name)!.get();
  return values
    .filter((v) => Object.entries(labels).every(([k, want]) => String(v.labels[k]) === want))
    .reduce((sum, v) => sum + v.value, 0);
}
const labelSets = async (name: string) => (await registry.getSingleMetric(name)!.get()).values.map((v) => v.labels);

describe('zeroCounters', () => {
  it('starts every reply, search and background-job series at 0, so "none yet" is not a missing series', async () => {
    expect(await labelSets('hearth_searches_total')).toEqual([]);
    zeroCounters();
    const [replies, searches, jobs] = await Promise.all(['hearth_replies_total', 'hearth_searches_total', 'hearth_background_jobs_total'].map(labelSets));
    for (const outcome of ['done', 'search', 'error', 'stopped'])
      for (const think of ['true', 'false']) expect(replies).toContainEqual(expect.objectContaining({ outcome, think }));
    for (const outcome of ['asked', 'approved', 'declined', 'failed']) expect(searches).toContainEqual(expect.objectContaining({ outcome }));
    for (const job of ['memory', 'summary', 'title', 'image'])
      for (const outcome of ['ok', 'preempted', 'failed']) expect(jobs).toContainEqual(expect.objectContaining({ job, outcome }));
    for (const name of ['hearth_replies_total', 'hearth_searches_total', 'hearth_background_jobs_total']) expect(await value(name)).toBe(0);
  });

  it('adds nothing to a count already made', async () => {
    searches.inc({ outcome: 'asked' });
    zeroCounters();
    expect(await value('hearth_searches_total', { outcome: 'asked' })).toBe(1);
  });
});

describe('hearth_ollama_up', () => {
  it('reads 1 when the probe finds Ollama and 0 when it does not, at each scrape', async () => {
    let problem: string | undefined;
    watchOllama(async () => problem);
    expect(await value('hearth_ollama_up')).toBe(1);
    problem = 'Ollama unreachable: connect ECONNREFUSED';
    expect(await value('hearth_ollama_up')).toBe(0);
    problem = undefined;
    expect(await value('hearth_ollama_up')).toBe(1);
  });
});
