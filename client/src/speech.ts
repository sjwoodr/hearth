// Reading aloud: a reply, or a word from the lookup popup, in the voices the user picked (Memories, About
// <name>): French sentences in their French voice, the rest in their English one. The server streams a WAV as the model makes it (first sound in ~0.3 s, then ~2x faster than it
// plays), so it's played with Web Audio block by block as it arrives, not handed to an <audio> element
// that would wait for the whole file. Pieces already heard are kept in memory, so a replay is instant.
import { useEffect, useSyncExternalStore } from 'react';
import { pcm16Decoder, readWavHeader, speechParts, type SpeechLanguage, type SpeechPart } from '../../shared/speech.ts';
import { api, ApiError } from './api.ts';

export type SpeechState = {
  /** null until the server has answered; false if nothing can read aloud there. */
  available: boolean | null;
  voices: string[];
  /** The user's voice for each language, and the server's. */
  chosen: Record<SpeechLanguage, string>;
  defaults: Record<SpeechLanguage, string>;
  /** What's being read: a key its button chose. */
  playing: string | null;
  /** True until its first sound. */
  waiting: boolean;
  /** The last thing that couldn't be read aloud, and why. */
  failed: { key: string; message: string } | null;
};

const NONE = { english: '', french: '' };
let state: SpeechState = { available: null, voices: [], chosen: NONE, defaults: NONE, playing: null, waiting: false, failed: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<SpeechState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

let loading: Promise<void> | undefined;
/** Asks the server once per page load; `again` asks anew (the voice picker, in case the model came back). */
export function loadVoices(again = false): Promise<void> {
  if (loading && !again) return loading;
  loading = api.voices().then(
    (v) => set({ available: true, ...v }),
    () => set({ available: false }),
  );
  return loading;
}

export const speechState = (): SpeechState => state;

export function useSpeech(): SpeechState {
  useEffect(() => void loadVoices(), []);
  return useSyncExternalStore(subscribe, () => state);
}

/** Saves this user's voice for `language`; it applies to the next thing read. */
export async function chooseVoice(language: SpeechLanguage, voice: string): Promise<void> {
  const before = state.chosen[language];
  set({ chosen: { ...state.chosen, [language]: voice } });
  try {
    await api.setVoice(language, voice);
  } catch (err) {
    set({ chosen: { ...state.chosen, [language]: before } });
    throw err;
  }
}

// ── playback ──

let context: AudioContext | undefined;
type Run = { key: string; abort: AbortController; sources: Set<AudioBufferSourceNode> };
let run: Run | undefined;

/** The audio output, started inside the tap: iOS only lets Web Audio make sound that a tap began. */
function audioOut(): AudioContext {
  // Safari: play like a video would, even with the ringer switched off.
  try {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
  } catch {
    // older browsers: nothing to set
  }
  context ??= new AudioContext();
  if (context.state !== 'running') void context.resume();
  // A moment of silence, so the tap that started this counts as having made a sound.
  const unlock = context.createBufferSource();
  unlock.buffer = context.createBuffer(1, 1, 22050);
  unlock.connect(context.destination);
  unlock.start();
  return context;
}

export function stopSpeaking(): void {
  const current = run;
  if (!current) return;
  run = undefined;
  current.abort.abort();
  for (const source of current.sources) {
    try {
      source.stop();
    } catch {
      // not started yet, or already over
    }
  }
  set({ playing: null, waiting: false });
}

/**
 * Reads `text` (speech text, see shared/speech.ts) aloud, or stops it if `key` is what's playing. Each
 * sentence goes to the voice for its language, or all of it to `language`'s. Call from a tap.
 */
export function toggleSpeaking(key: string, text: string, language?: SpeechLanguage): void {
  if (state.playing === key) return stopSpeaking();
  stopSpeaking();
  const parts = speechParts(text, { language });
  // The voices as they are now: a change while this plays applies to the next thing read.
  const voices = state.chosen;
  if (!parts.length || !voices.english || !voices.french) return;
  const out = audioOut();
  const mine: Run = { key, abort: new AbortController(), sources: new Set() };
  run = mine;
  set({ playing: key, waiting: true, failed: null });
  play(out, mine, parts, voices).catch((err) => {
    if (run !== mine) return; // stopped: the abort is what failed
    stopSpeaking();
    set({ failed: { key, message: err instanceof ApiError ? err.message : "Couldn't read that aloud." } });
  });
}

// Margin for scheduling a block ahead of the audio clock. Arriving audio is gathered into blocks of
// BLOCK_S (fewer nodes), except while less than LOW_S is queued to play: then each piece goes as it comes,
// so the start is quick and a slow moment doesn't leave a silence.
const LEAD_S = 0.06;
const BLOCK_S = 0.4;
const LOW_S = 0.3;

async function play(out: AudioContext, mine: Run, parts: SpeechPart[], voices: Record<SpeechLanguage, string>) {
  let at = 0; // when the next block starts, on the audio clock
  const queued = () => at - out.currentTime;
  const schedule = (samples: Float32Array, rate: number) => {
    if (run !== mine || !samples.length) return;
    const buffer = out.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = out.createBufferSource();
    source.buffer = buffer;
    source.connect(out.destination);
    const start = Math.max(at, out.currentTime + LEAD_S);
    source.start(start);
    at = start + buffer.duration;
    mine.sources.add(source);
    source.onended = () => {
      mine.sources.delete(source);
      // The last block of the last piece: done.
      if (run === mine && mine.sources.size === 0 && mine.abort.signal.reason === 'done') {
        run = undefined;
        set({ playing: null });
      }
    };
    if (state.waiting) set({ waiting: false });
  };
  for (const part of parts) {
    const voice = voices[part.language];
    const key = `${voice}\n${part.text}`;
    const kept = heard.get(key);
    if (kept) {
      heard.delete(key); // to the back of the line
      heard.set(key, kept);
      schedule(kept.samples, kept.rate);
    } else {
      await stream(part.text, voice, mine, schedule, queued);
    }
    if (run !== mine) return;
  }
  // Everything is scheduled; the last block's end says when it's over (or now, if nothing was).
  mine.abort.abort('done');
  if (mine.sources.size === 0 && run === mine) {
    run = undefined;
    set({ playing: null });
  }
}

/** One piece from the server, scheduled block by block as its bytes arrive. */
async function stream(
  text: string,
  voice: string,
  mine: Run,
  schedule: (samples: Float32Array, rate: number) => void,
  queued: () => number,
) {
  const res = await api.speech(text, voice, mine.abort.signal);
  const reader = res.body!.getReader();
  let head: Uint8Array = new Uint8Array(0);
  let format: ReturnType<typeof readWavHeader>;
  let decode: ReturnType<typeof pcm16Decoder> | undefined;
  const all: Float32Array[] = [];
  let pending: Float32Array[] = [];
  let pendingLength = 0;
  const flush = (last: boolean) => {
    if (!format || !pendingLength) return;
    if (!last && pendingLength < format.sampleRate * BLOCK_S && queued() > LOW_S) return;
    schedule(join(pending, pendingLength), format.sampleRate);
    pending = [];
    pendingLength = 0;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let bytes: Uint8Array = value;
    if (!format) {
      head = joinBytes(head, value);
      format = readWavHeader(head);
      if (!format) continue;
      decode = pcm16Decoder(format.channels);
      bytes = head.subarray(format.dataOffset);
    }
    const samples = decode!(bytes);
    if (!samples.length) continue;
    all.push(samples);
    pending.push(samples);
    pendingLength += samples.length;
    flush(false);
  }
  flush(true);
  if (format) remember(`${voice}\n${text}`, join(all, all.reduce((n, s) => n + s.length, 0)), format.sampleRate);
}

// Pieces already heard, newest last. About five minutes of audio at 24 kHz is ~29 MB.
const MAX_KEPT_SAMPLES = 24_000 * 60 * 5;
const heard = new Map<string, { samples: Float32Array; rate: number }>();
let keptSamples = 0;

function remember(key: string, samples: Float32Array, rate: number) {
  if (!samples.length || samples.length > MAX_KEPT_SAMPLES || heard.has(key)) return;
  heard.set(key, { samples, rate });
  keptSamples += samples.length;
  for (const [oldest, kept] of heard) {
    if (keptSamples <= MAX_KEPT_SAMPLES) break;
    heard.delete(oldest);
    keptSamples -= kept.samples.length;
  }
}

function join(parts: Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function joinBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
