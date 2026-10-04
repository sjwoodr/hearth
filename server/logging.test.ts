import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { jsonLine } from './logging.ts';

const NOW = new Date('2026-10-04T12:00:00Z');

describe('JSON log lines', () => {
  it('carry the time, level, service and message, and the chat when one is named', () => {
    expect(JSON.parse(jsonLine('info', 'worker', ['summary: chat %d updated', 12], NOW))).toEqual({
      time: '2026-10-04T12:00:00.000Z',
      level: 'info',
      service: 'worker',
      msg: 'summary: chat 12 updated',
      chat: 12,
    });
    expect(JSON.parse(jsonLine('info', 'hearth', ['hearth listening'], NOW))).not.toHaveProperty('chat');
  });

  it('keep an error\'s message in the text and its stack alongside', () => {
    const line = JSON.parse(jsonLine('error', 'hearth', ['title: chat 3 failed:', new Error('model down')], NOW));
    expect(line).toMatchObject({ level: 'error', chat: 3 });
    expect(line.msg).toContain('title: chat 3 failed: Error: model down');
    expect(line.stack).toMatch(/^Error: model down\n\s+at /);
  });

  it('are what the real server writes with HEARTH_LOG_FORMAT=json; the default stays plain', { timeout: 30_000 }, async () => {
    const firstLine = (format: string) =>
      new Promise<string>((resolve, reject) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-log-'));
        const child = spawn('node', ['server/index.ts'], {
          cwd: path.resolve(import.meta.dirname, '..'),
          env: { ...process.env, HEARTH_DB_PATH: path.join(dir, 'h.db'), HEARTH_PORT: '0', HEARTH_GATEWAY_URL: '', HEARTH_ROLE: 'all', HEARTH_LOG_FORMAT: format },
        });
        let out = '';
        child.stdout.on('data', (d) => {
          out += d;
          if (!out.includes('\n')) return;
          child.kill();
          fs.rmSync(dir, { recursive: true, force: true });
          resolve(out.split('\n')[0]!);
        });
        child.on('error', reject);
        setTimeout(() => reject(new Error(`no output: ${out}`)), 10_000);
      });
    expect(JSON.parse(await firstLine('json'))).toMatchObject({ level: 'info', service: 'hearth', msg: expect.stringContaining('hearth listening') });
    expect(await firstLine('text')).toMatch(/^hearth listening on /);
  });
});
