import type { ChatFn, JsonFn } from './ollama.ts';

/** A background model call was cancelled so a chat reply could go first. Retry it later. */
export class PreemptedError extends Error {
  constructor() {
    super('Paused so a chat reply could go first.');
    this.name = 'PreemptedError';
  }
}
export const isPreempted = (err: unknown): err is PreemptedError => err instanceof PreemptedError;

/** How long a background call may wait before it takes the next free slot and can't be preempted. */
export const BACKGROUND_MAX_WAIT_MS = 10 * 60 * 1000;

type Job = {
  kind: 'reply' | 'background';
  userId?: number;
  queuedAt: number;
  /** Starts the job once it has a slot. */
  start: () => void;
  /** Cancels a running background call so a reply can have its slot. Cleared once used. */
  preempt?: () => void;
  /** Preempted, and its slot not yet released. */
  freeing?: boolean;
  /** Waited past BACKGROUND_MAX_WAIT_MS: runs next, and isn't preempted. */
  protected?: boolean;
};

/** A slot held for one model call. Release it exactly once, when the call is over. */
export type Lease = {
  /** Aborts if the caller's signal aborts, or (background only) if a reply preempts this call. */
  signal: AbortSignal;
  isPreempted: () => boolean;
  release: () => void;
};

export type SchedulerOptions = {
  /** Requests Ollama runs at once: must equal its OLLAMA_NUM_PARALLEL, or chat-first breaks. */
  slots?: number;
  backgroundMaxWaitMs?: number;
  now?: () => number;
  /** For metrics: a call got a slot after waiting, a background call was preempted, one went overdue. */
  onStart?: (kind: 'reply' | 'background', waitedMs: number) => void;
  onPreempt?: () => void;
  onOverdue?: () => void;
};

/**
 * Ollama runs a fixed number of requests at once (its slots), so chat replies and background jobs
 * (memory extraction, summaries, titles, image descriptions) share them, and chat goes first:
 *
 * - A reply takes a free slot. If none is free, it preempts a running background call (which fails
 *   with PreemptedError and is retried later); if every slot holds a reply, it waits, and
 *   `onQueued` tells the client. Waiting replies take turns between users: a user with no reply
 *   running goes before one who already has one.
 * - A background call only takes a slot when no reply is waiting for one. Once it has waited
 *   BACKGROUND_MAX_WAIT_MS it goes next and can't be preempted, so memories still get written on a
 *   busy day.
 *
 * Holding calls back here, not in Ollama's own queue, is what lets a reply overtake background work.
 * The same scheduler runs in-process (one hearth process, the default) and inside the gateway.
 */
export function createModelScheduler(opts: SchedulerOptions = {}) {
  return new ModelScheduler(opts);
}

export class ModelScheduler {
  readonly slots: number;
  #maxWait: number;
  #now: () => number;
  #running = new Set<Job>();
  #waiting: Job[] = [];
  // When each user's reply last got a slot (a counter, not a clock), so ties go to whoever waited
  // longest for a turn.
  #lastServed = new Map<number | undefined, number>();
  #served = 0;
  #hooks: Pick<SchedulerOptions, 'onStart' | 'onPreempt' | 'onOverdue'>;

  constructor(opts: SchedulerOptions = {}) {
    this.#hooks = opts;
    this.slots = Math.max(1, Math.floor(opts.slots ?? 1));
    this.#maxWait = opts.backgroundMaxWaitMs ?? BACKGROUND_MAX_WAIT_MS;
    this.#now = opts.now ?? Date.now;
  }

  /** True while a reply is generating or waiting for a slot. Background sweeps hold off meanwhile. */
  replyActive = (): boolean => [...this.#running, ...this.#waiting].some((j) => j.kind === 'reply');

  /** What the slots are doing right now (for tests now, metrics later). */
  stats() {
    const running = [...this.#running];
    return {
      slots: this.slots,
      runningReplies: running.filter((j) => j.kind === 'reply').length,
      runningBackground: running.filter((j) => j.kind === 'background').length,
      waitingReplies: this.#repliesWaiting().length,
      waitingBackground: this.#waiting.filter((j) => j.kind === 'background').length,
    };
  }

  /**
   * Waits for a slot and holds it until `release()`. The primitive under chat() and background(),
   * and what the gateway uses to proxy raw Ollama requests.
   */
  async lease(
    kind: 'reply' | 'background',
    opts: { userId?: number; signal?: AbortSignal; onQueued?: (position: number) => void } = {},
  ): Promise<Lease> {
    const controller = new AbortController();
    let preempted = false;
    opts.signal?.addEventListener('abort', () => controller.abort(opts.signal!.reason), { once: true });
    if (opts.signal?.aborted) controller.abort(opts.signal.reason);
    // Preemptible from the moment it holds a slot, before the caller resumes.
    const preempt =
      kind === 'background'
        ? () => {
            preempted = true;
            controller.abort(new PreemptedError());
          }
        : undefined;
    const job = await this.#acquire({ kind, userId: opts.userId, queuedAt: this.#now(), preempt }, controller.signal, opts.onQueued);
    let released = false;
    return {
      signal: controller.signal,
      isPreempted: () => preempted,
      release: () => {
        if (released) return;
        released = true;
        this.#release(job);
      },
    };
  }

  chat(fn: ChatFn): ChatFn {
    const scheduler = this;
    return async function* (messages, signal, callOpts) {
      const lease = await scheduler.lease('reply', { userId: callOpts?.userId, signal, onQueued: callOpts?.onQueued });
      try {
        yield* fn(messages, signal, callOpts);
      } finally {
        lease.release();
      }
    };
  }

  background(fn: JsonFn): JsonFn {
    return async (messages, schema, signal) => {
      const lease = await this.lease('background', { signal });
      try {
        if (lease.isPreempted()) throw new PreemptedError(); // preempted before it even started
        return await fn(messages, schema, lease.signal);
      } catch (err) {
        if (lease.isPreempted()) throw new PreemptedError();
        throw err;
      } finally {
        lease.release();
      }
    };
  }

  #runningReplies(userId?: number) {
    return [...this.#running].filter((j) => j.kind === 'reply' && j.userId === userId).length;
  }

  #byTurn = (a: Job, b: Job) =>
    this.#runningReplies(a.userId) - this.#runningReplies(b.userId) ||
    (this.#lastServed.get(a.userId) ?? -1) - (this.#lastServed.get(b.userId) ?? -1) ||
    a.queuedAt - b.queuedAt;

  #repliesWaiting() {
    return this.#waiting.filter((j) => j.kind === 'reply');
  }

  #freeing() {
    return [...this.#running].filter((j) => j.freeing).length;
  }

  // Gives free slots out, then makes room for any replies still waiting.
  #pump() {
    this.#markOverdue();
    while (this.#running.size < this.slots && this.#waiting.length > 0) this.#start(this.#next());
    this.#preemptForWaitingReplies();
  }

  #markOverdue() {
    for (const job of this.#waiting) {
      if (job.kind === 'background' && !job.protected && this.#now() - job.queuedAt >= this.#maxWait) {
        job.protected = true;
        this.#hooks.onOverdue?.();
      }
    }
  }

  // An overdue background call first, then replies (the user with the fewest replies running, then
  // the one served least recently, then the longest waiting), then background calls in order.
  #next(): Job {
    return this.#waiting.find((j) => j.protected) ?? this.#repliesWaiting().sort(this.#byTurn)[0] ?? this.#waiting[0]!;
  }

  #start(job: Job) {
    this.#waiting.splice(this.#waiting.indexOf(job), 1);
    this.#running.add(job);
    if (job.kind === 'reply') this.#lastServed.set(job.userId, ++this.#served);
    this.#hooks.onStart?.(job.kind, this.#now() - job.queuedAt);
    job.start();
  }

  // One preempted background call per waiting reply, beyond those already freeing a slot.
  #preemptForWaitingReplies() {
    const preemptible = [...this.#running].filter((j) => j.kind === 'background' && !j.protected && j.preempt);
    for (const job of preemptible.slice(0, Math.max(0, this.#repliesWaiting().length - this.#freeing()))) {
      const preempt = job.preempt!;
      job.preempt = undefined; // once is enough; its slot frees when the call unwinds
      job.freeing = true;
      this.#hooks.onPreempt?.();
      preempt();
    }
  }

  #release(job: Job) {
    this.#running.delete(job);
    this.#pump();
  }

  // Waits for a slot; rejects if `signal` aborts first (the user pressed Stop while queued).
  #acquire(job: Omit<Job, 'start'>, signal: AbortSignal | undefined, onQueued?: (position: number) => void) {
    return new Promise<Job>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
      const entry: Job = { ...job, start: () => resolve(entry) };
      const onAbort = () => {
        const at = this.#waiting.indexOf(entry);
        if (at === -1) return;
        this.#waiting.splice(at, 1);
        reject(signal!.reason ?? new Error('aborted'));
        this.#pump();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiting.push(entry);
      this.#pump();
      if (!this.#waiting.includes(entry)) {
        signal?.removeEventListener('abort', onAbort);
        return;
      }
      // Queued only if no preempted background call is about to hand this reply its slot.
      const position = this.#repliesWaiting().sort(this.#byTurn).indexOf(entry) + 1;
      if (entry.kind === 'reply' && position > this.#freeing()) onQueued?.(position - this.#freeing());
    });
  }
}
