import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSystemPrompt } from './system-prompt.ts';

const shipped = path.resolve(import.meta.dirname, '../prompts/system.md');

describe('the assistant name in the system prompt', () => {
  it('is hearth by default, with no placeholder left', () => {
    const prompt = readSystemPrompt(shipped, 'hearth');
    expect(prompt).toMatch(/^You are hearth, a warm, witty/);
    expect(prompt).not.toContain('{{');
  });

  it('takes another name, while the app keeps its own', () => {
    const prompt = readSystemPrompt(shipped, 'Gemma');
    expect(prompt).toMatch(/^You are Gemma, a warm, witty/);
    expect(prompt).not.toContain('{{');
    // The chat screen is still hearth: the model shouldn't call it Gemma's display.
    expect(prompt).toContain('is hearth, the app you speak through');
    expect(prompt).toContain("say it's hearth's display");
  });

  it('fills every placeholder in a replacement prompt too', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-prompt-')), 'system.md');
    fs.writeFileSync(file, '\nYou are {{name}}. Sign off as {{name}}.\n');
    expect(readSystemPrompt(file, 'Gemma')).toBe('You are Gemma. Sign off as Gemma.');
  });
});
