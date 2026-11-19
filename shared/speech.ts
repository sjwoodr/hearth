// Reading aloud (README "Listen"): what of a reply gets spoken, in what pieces, and how the browser reads
// the WAV that streams back. Shared so the server's tests cover what the client does.
import { plainSymbols } from './plain-symbols.ts';

/** The most the server reads aloud in one request; the client sends pieces of SPEECH_CHUNK_CHARS. */
export const MAX_SPEECH_CHARS = 500;
/**
 * Replies are read in pieces this long, one request each, the next asked for once the last is made.
 * The audio streams as it's made, so the size doesn't change how soon it starts.
 */
export const SPEECH_CHUNK_CHARS = 300;

/** "female-french" → "French, female"; "female-american-english" → "American English, female". */
export function voiceLabel(voice: string): string {
  if (voice === 'default') return "Default (the model's own)";
  const m = /^(female|male)-(.+)$/.exec(voice);
  if (!m) return voice;
  const language = m[2]!
    .split('-')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
  return `${language}, ${m[1]}`;
}

/** Voices in picker order: the model's own first, then by language, female before male. */
export const sortVoices = (voices: string[]) =>
  [...voices].sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : voiceLabel(a).localeCompare(voiceLabel(b))));

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
// Emoji and what joins or styles them; read aloud they're noise ("smiling face with smiling eyes").
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

/**
 * A reply's Markdown as the words to say: code blocks, links' addresses, markup and emoji left out,
 * a link read by its text, a table row as its cells. Lines stay lines.
 */
export function speechText(markdown: string): string {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of plainSymbols(markdown).split('\n')) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && line.trim() === f[1]) fence = undefined;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    if (TABLE_RULE.test(line) || THEMATIC_BREAK.test(line)) {
      lines.push('');
      continue;
    }
    let l = line
      .replace(/^ {0,3}#{1,6}\s+/, '')
      .replace(/^\s*(?:>\s?)+/, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '');
    if (/^\s*\|.*\|\s*$/.test(l)) {
      l = l
        .trim()
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(', ');
    }
    lines.push(inline(l));
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inline(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<https?:\/\/[^>\s]+>/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(?<![\p{L}\p{N}*])\*(?=\S)(.+?)(?<=\S)\*(?![\p{L}\p{N}*])/gu, '$1')
    .replace(/(?<![\p{L}\p{N}_])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    // "je mange → nous mangeons": a pause, not "right arrow".
    .replace(/\s*(?:→|⇒|->|=>)\s*/g, ', ')
    .replace(EMOJI, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

const ENDS_A_THOUGHT = /[.!?…:;,»"”')\]]$/;

/**
 * Text cut into pieces of at most `max` characters for one speech request each: whole sentences where
 * they fit, else clauses, else words. A line that ends without punctuation gets a full stop, so a list
 * read as one piece still pauses between its items.
 */
export function speechChunks(text: string, max = SPEECH_CHUNK_CHARS): string[] {
  const pieces: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    const ended = ENDS_A_THOUGHT.test(line) ? line : `${line}.`;
    for (const sentence of splitTo(ended, max, /(?<=[.!?…])\s+/)) {
      for (const clause of splitTo(sentence, max, /(?<=[,;:])\s+/)) pieces.push(...splitTo(clause, max, /\s+/, true));
    }
  }
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + piece.length <= max) chunks[chunks.length - 1] = `${last} ${piece}`;
    else chunks.push(piece);
  }
  return chunks;
}

// `text` as is if it fits, else split at `at` and packed back up to `max`; a single word longer than
// `max` (no such French word, but a pasted string might be) is cut when `hard`.
function splitTo(text: string, max: number, at: RegExp, hard = false): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  for (const part of text.split(at)) {
    if (!part) continue;
    const last = out.at(-1);
    if (last !== undefined && last.length + 1 + part.length <= max) out[out.length - 1] = `${last} ${part}`;
    else if (hard && part.length > max) for (let i = 0; i < part.length; i += max) out.push(part.slice(i, i + max));
    else out.push(part);
  }
  return out;
}

export type WavFormat = { sampleRate: number; channels: number; dataOffset: number };

const MAX_WAV_HEADER = 4096;
const ascii = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/**
 * The format of a 16-bit PCM WAV and where its samples start, read from its first bytes. Undefined
 * while more bytes are needed. Ollama streams the WAV as it's made, so its length fields are
 * placeholders (0xFFFFFFFF) and aren't used. Throws for anything that isn't 16-bit PCM.
 */
export function readWavHeader(head: Uint8Array): WavFormat | undefined {
  if (head.length < 12) return undefined;
  if (ascii(head, 0) !== 'RIFF' || ascii(head, 8) !== 'WAVE') throw new Error('The audio is not a WAV.');
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let format: Omit<WavFormat, 'dataOffset'> | undefined;
  for (let at = 12; ; ) {
    if (at >= MAX_WAV_HEADER) throw new Error('The WAV header is too long.');
    if (head.length < at + 8) return undefined;
    const id = ascii(head, at);
    const size = view.getUint32(at + 4, true);
    if (id === 'data') {
      if (!format) throw new Error('The WAV has no format.');
      return { ...format, dataOffset: at + 8 };
    }
    if (id === 'fmt ') {
      if (head.length < at + 24) return undefined;
      const encoding = view.getUint16(at + 8, true);
      const bits = view.getUint16(at + 22, true);
      // 1 is PCM; 0xFFFE (extensible) is PCM too when it says 16 bits.
      if ((encoding !== 1 && encoding !== 0xfffe) || bits !== 16) throw new Error('The audio is not 16-bit PCM.');
      format = { channels: view.getUint16(at + 10, true), sampleRate: view.getUint32(at + 12, true) };
      if (!format.channels || !format.sampleRate) throw new Error('The WAV format is broken.');
    }
    at += 8 + size + (size & 1);
  }
}

/**
 * Turns 16-bit little-endian PCM into samples between -1 and 1, mixed down to one channel. Bytes
 * arrive in network-sized pieces, so a frame split between two pieces waits for the rest.
 */
export function pcm16Decoder(channels: number): (bytes: Uint8Array) => Float32Array {
  const frame = 2 * channels;
  let carry = new Uint8Array(0);
  return (bytes) => {
    const all = new Uint8Array(carry.length + bytes.length);
    all.set(carry);
    all.set(bytes, carry.length);
    const usable = all.length - (all.length % frame);
    carry = all.slice(usable);
    const view = new DataView(all.buffer, 0, usable);
    const out = new Float32Array(usable / frame);
    for (let i = 0; i < out.length; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += view.getInt16((i * channels + c) * 2, true);
      out[i] = sum / channels / 32768;
    }
    return out;
  };
}
