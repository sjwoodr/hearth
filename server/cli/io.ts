import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

// A human at a terminal gets fzf, $EDITOR and a pager. Piped input (scripts, tests) gets
// numbered prompts read line by line, like aubemer's admin.sh.
export const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
const hasFzf = interactive && spawnSync('fzf', ['--version']).status === 0;

// ── line input ─────────────────────────────────────────────────────────────────
// Piped answers can all arrive before the first prompt is asked, so one reader queues them.
const queue: string[] = [];
const waiters: ((line: string | undefined) => void)[] = [];
let reader: readline.Interface | undefined;
let ended = false;

function nextPipedLine(): Promise<string | undefined> {
  if (!reader) {
    reader = readline.createInterface({ input: process.stdin, terminal: false });
    reader.on('line', (line) => {
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else queue.push(line);
    });
    reader.on('close', () => {
      ended = true;
      for (const waiter of waiters.splice(0)) waiter(undefined);
    });
  }
  if (queue.length) return Promise.resolve(queue.shift());
  if (ended) return Promise.resolve(undefined);
  return new Promise((resolve) => waiters.push(resolve));
}

export function closeInput(): void {
  reader?.close();
}

/** Returns undefined on Ctrl-C, Ctrl-D or end of piped input. */
export async function ask(question: string, hidden = false): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    process.stderr.write(question);
    const line = await nextPipedLine();
    process.stderr.write('\n');
    return line;
  }
  // A fresh interface per question, so stdin isn't held in raw mode while fzf or $EDITOR runs.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // readline redraws "prompt + typed text" as one write and echoes keystrokes one by one.
    // Keep the prompt, drop everything typed.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
      if (s.startsWith(question)) process.stdout.write(question);
    };
  }
  return new Promise((resolve) => {
    let answered = false;
    let answer = '';
    rl.on('SIGINT', () => rl.close());
    rl.on('close', () => {
      if (hidden || !answered) process.stdout.write('\n');
      resolve(answered ? answer : undefined);
    });
    rl.question(question, (a) => {
      answer = a;
      answered = true;
      rl.close();
    });
  });
}

export async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test((await ask(`${question} [y/N] `)) ?? '');
}

// ── picking from a list ────────────────────────────────────────────────────────
export type Choice = { key: string; label: string };

/** Returns the chosen key, or undefined when the user backs out (ESC, blank, bad number). */
export async function pick(header: string, choices: Choice[], preview?: string): Promise<string | undefined> {
  if (choices.length === 0) return undefined;
  const oneLine = (s: string) => s.replace(/\s+/g, ' ');
  if (hasFzf) {
    const args = [
      '--height=90%',
      '--reverse',
      '--border',
      '--ansi',
      '--delimiter=\t',
      '--with-nth=2..',
      `--header=${header}  (↑↓ move · type to filter · ESC back)`,
      '--prompt=› ',
    ];
    // Detail goes in the preview pane: fzf owns the screen, so anything printed above it scrolls away.
    if (preview) args.push(`--preview=${preview}`, '--preview-window=right:55%:wrap');
    const input = choices.map((c) => `${c.key}\t${oneLine(c.label)}`).join('\n');
    const r = spawnSync('fzf', args, { input, stdio: ['pipe', 'pipe', 'inherit'], encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) return undefined;
    return r.stdout.split('\t')[0];
  }
  process.stderr.write(`  ${header}\n`);
  choices.forEach((c, i) => process.stderr.write(`${String(i + 1).padStart(4)}) ${oneLine(c.label)}\n`));
  const n = Number(await ask('  # (blank = back): '));
  return choices[n - 1]?.key;
}

/** A shell command fzf runs for the preview pane: this CLI's hidden `_preview <kind> <key>`. */
export function previewCommand(kind: string): string {
  const script = path.join(import.meta.dirname, 'hearth.ts');
  return `'${process.execPath}' '${script}' _preview ${kind} {1}`;
}

// ── longer text ────────────────────────────────────────────────────────────────
/** Opens $VISUAL/$EDITOR on the text; piped input supplies the new text as one line instead. */
export async function editText(initial: string): Promise<string | undefined> {
  if (!interactive) return ask('New text: ');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-')), 'edit.txt');
  fs.writeFileSync(file, initial, { mode: 0o600 });
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  const r = spawnSync(`${editor} "${file}"`, { shell: true, stdio: 'inherit' });
  const text = fs.readFileSync(file, 'utf8').replace(/\n+$/, '');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  return r.status === 0 ? text : undefined;
}

/** Long output goes through less at a terminal (quits at once if it fits), plain stdout otherwise. */
export function page(text: string): void {
  if (!interactive) {
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    return;
  }
  spawnSync('less', ['-R', '-F', '-X'], { input: text, stdio: ['pipe', 'inherit', 'inherit'] });
}

/** Waits before a menu redraws, so output isn't wiped by fzf. Only when a human is driving. */
export async function pause(): Promise<void> {
  if (interactive) await ask('  ↵  press Enter to continue… ');
}

export function localTime(sqliteUtc: string): string {
  const d = new Date(`${sqliteUtc.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? sqliteUtc : d.toLocaleString();
}
