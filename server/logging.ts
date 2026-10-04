// Log format. By default hearth writes plain lines ("summary: chat 12 updated"), easy to read in a
// terminal. With HEARTH_LOG_FORMAT=json each line becomes one JSON object, for a log store such as
// Loki: {"time","level","service","msg"}, plus "chat" when the message names one, and the error's
// stack when it carries one. Done by wrapping console, so the existing log calls stay as they are.
import { format } from 'node:util';

type Level = 'info' | 'warn' | 'error';

export function jsonLine(level: Level, service: string, args: unknown[], now = new Date()): string {
  const msg = format(...args);
  const chat = /\bchat (\d+)\b/.exec(msg)?.[1];
  const stack = args.find((a): a is Error => a instanceof Error)?.stack;
  return JSON.stringify({
    time: now.toISOString(),
    level,
    service,
    msg,
    ...(chat ? { chat: Number(chat) } : {}),
    ...(stack ? { stack } : {}),
  });
}

/** Switches this process's console to JSON lines when `logFormat` is "json". */
export function setLogFormat(logFormat: string, service: string) {
  if (logFormat !== 'json') return;
  const out = (level: Level, write: (line: string) => void) => (...args: unknown[]) => write(`${jsonLine(level, service, args)}\n`);
  console.log = out('info', (l) => process.stdout.write(l));
  console.info = console.log;
  console.warn = out('warn', (l) => process.stderr.write(l));
  console.error = out('error', (l) => process.stderr.write(l));
}
