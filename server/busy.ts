import type { ChatFn, JsonFn } from './ollama.ts';

/** A background model call was cancelled so a chat reply could go first. Retry it later. */
export class PreemptedError extends Error {
  constructor() {
    super('Paused so a chat reply could go first.');
    this.name = 'PreemptedError';
  }
}
export const isPreempted = (err: unknown): err is PreemptedError => err instanceof PreemptedError;

/**
 * Ollama runs one request at a time, so chat replies and background jobs (memory extraction,
 * summaries, titles) share it. Chat goes first: a new reply cancels any background call in
 * flight, which fails with PreemptedError and is retried later. Replies are only ever queued
 * behind other replies.
 */
export function createModelScheduler() {
  let replies = 0;
  const background = new Set<AbortController>();
  return {
    /** True while a chat reply is being generated. */
    replyActive: () => replies > 0,
    /** Cancels every background call in flight. */
    preemptBackground: () => {
      for (const c of background) c.abort();
    },
    chat(fn: ChatFn): ChatFn {
      return async function* (messages, signal, opts) {
        replies++;
        try {
          yield* fn(messages, signal, opts);
        } finally {
          replies--;
        }
      };
    },
    background(fn: JsonFn): JsonFn {
      return async (messages, schema, signal) => {
        const controller = new AbortController();
        signal?.addEventListener('abort', () => controller.abort());
        background.add(controller);
        try {
          return await fn(messages, schema, controller.signal);
        } catch (err) {
          if (controller.signal.aborted) throw new PreemptedError();
          throw err;
        } finally {
          background.delete(controller);
        }
      };
    },
  };
}
