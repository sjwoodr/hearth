# Ollama slots: how many replies at once

*October 2026. How many requests Ollama should run at the same time on this machine, measured with
1 to 8 simulated people chatting, and why hearth settled on two.*

## The question

Ollama runs a fixed number of requests at once, its **slots** (`OLLAMA_NUM_PARALLEL`). Anything
beyond that queues inside Ollama. hearth has its own scheduler in front (`server/busy.ts`, or the
model gateway when hearth runs as several services) that hands out those slots: a reply takes a
free slot, or preempts background work (memory extraction, summaries), or waits its turn. So the
scheduler needs to know the real number (`HEARTH_OLLAMA_SLOTS` must equal `OLLAMA_NUM_PARALLEL`),
and someone has to pick it.

hearth ran with one slot until October 2026. Planning to run it as several services on a home
Kubernetes cluster raised the obvious questions: what happens with more than one person, what does
each slot cost, and does a busy machine throw away its cached conversations?

## Setup

Same machine as the [model selection](model-selection.md): a mini PC with a Ryzen 9 7940HS, the
integrated Radeon 780M and 64 GB of DDR5 shared between CPU and GPU. Ollama 0.33.3 with the iGPU
enabled, flash attention and an 8-bit KV cache. Model: Gemma 4 26B-A4B (`gemma4:26b-a4b-it-qat`),
16k context, thinking off: hearth's everyday chat settings.

Nothing else used the GPU during the runs. (Diablo 3 running on the same machine cut a single
reply from ~25 to ~15 tok/s in an earlier check, so games were closed.)

## Method

`scripts/bench-slots.ts` talks to Ollama directly, not through hearth. For each number of users it
starts that many simulated people **at the same time**. Each one has a conversation of its own
(~1,300 tokens: a tutoring system prompt and six earlier exchanges) and sends three messages back
to back, each asking for about 250 words (capped at 256 tokens). Every run uses fresh
conversations, so nothing is cached from before.

For every reply it records:

| Measure | Meaning |
|---|---|
| Wait | Request sent → first word. Includes queueing and reading the prompt. |
| Speed per reply | Ollama's own `eval_count / eval_duration` for that reply. |
| Combined speed | All tokens from all users ÷ the scenario's wall time (so it includes prompt reading and queueing). |
| Prompt reading | Ollama's `prompt_eval_duration`. A user's first message reads the whole chat; on later messages a short time means Ollama still had that conversation cached. |
| Memory | The model's size in `ollama ps` afterwards. |

Then the slot count was changed (edit the systemd drop-in, restart Ollama) and the run repeated, for
1, 2, 4 and 8 slots. Each cell below is **one run**, so treat small differences as noise.

```
node scripts/bench-slots.ts                     # users 1,2,3,4; 3 messages each
node scripts/bench-slots.ts --users 1,2,4,8     # the 8-slot run
```

The raw results are in [bench/ollama-slots/](bench/ollama-slots/).

## Results

Waits are median / worst. Speeds in tokens per second.

### 1 slot (15.0 GB)

| Users | Wait | Per reply | Combined | Prompt: 1st msg | Prompt: later |
|---|---|---|---|---|---|
| 1 | 1.4 / 3.8 s | 23.4 | 19.5 | 3.8 s | 1.4 s |
| 2 | 14.3 / 19.0 s | 23.2 | 19.1 | 3.9 s | 1.4 s |
| 3 | 27.1 / 34.4 s | 23.1 | 18.9 | 4.0 s | 1.4 s |
| 4 | 39.8 / 49.7 s | 23.1 | 18.9 | 4.0 s | 1.4 s |

### 2 slots (15.3 GB)

| Users | Wait | Per reply | Combined | Prompt: 1st msg | Prompt: later |
|---|---|---|---|---|---|
| 1 | 1.4 / 3.9 s | 23.7 | 19.7 | 3.8 s | 1.4 s |
| 2 | 7.7 / 13.2 s | 16.7 | 23.0 | 7.5 s | 1.6 s (worst 7.4) |
| 3 | 8.0 / 28.2 s | 17.5 | 25.6 | 7.7 s | 2.3 s (worst 4.9) |
| 4 | 20.1 / 30.9 s | 17.5 | 26.8 | 7.8 s | 2.3 s |

### 4 slots (16.4 GB)

| Users | Wait | Per reply | Combined | Prompt: 1st msg | Prompt: later |
|---|---|---|---|---|---|
| 1 | 1.4 / 3.4 s | 23.4 | 19.7 | 3.4 s | 1.4 s |
| 2 | 2.5 / 7.6 s | 17.3 | 27.0 | 7.3 s | 2.3 s |
| 3 | 4.1 / 11.3 s | 9.8 | 23.6 | 10.5 s | 3.7 s |
| 4 | 3.8 / 15.7 s | 10.6 | 32.7 | 10.6 s | 3.1 s |

### 8 slots (17.7 GB)

| Users | Wait | Per reply | Combined | Prompt: 1st msg | Prompt: later |
|---|---|---|---|---|---|
| 1 | 1.4 / 3.3 s | 23.5 | 19.8 | 3.3 s | 1.4 s |
| 2 | 2.6 / 7.5 s | 17.3 | 27.0 | 7.2 s | 2.3 s |
| 4 | 3.7 / 15.3 s | 10.6 | 33.0 | 10.4 s | 3.1 s |
| 8 | 4.0 / 31.8 s | 5.5 | 35.7 | 12.7 s | 3.3 s |

## What it shows

**The GPU's output is fixed; slots only decide how it's shared.** This machine's speed is set by
memory bandwidth (the model reads its active weights for every token), and all replies running at
once share it. The combined rate tops out around 33-36 tok/s however many slots there are:

| Replies at once | Each reply |
|---|---|
| 1 | ~23 tok/s |
| 2 | ~17 tok/s |
| 4 | ~11 tok/s |
| 8 | ~5.5 tok/s |

Two people at once got ~1.4× the combined output of one (27 vs 19.7 tok/s); four ~1.7×; eight barely more. A lone reply runs at full
speed with any slot count: extra slots cost nothing until they're used.

**More people than slots means queueing, roughly one reply's length each.** With one slot, every
reply ahead of you adds ~12 s (a 256-token reply at 23 tok/s plus its prompt): 14 s median wait for
two people, 40 s for four. With enough slots everyone starts within a few seconds, and reading the
prompt (which the GPU also shares) becomes most of the wait.

**Slots are cheap in memory**, about 0.33 GB each: 15.0 GB with one, 15.3 with two, 16.4 with four,
17.7 with eight. Gemma 4's sliding-window attention keeps the per-conversation cache small.

**Ollama kept every conversation cached, at every setting.** This was the surprise. With four people
taking turns through **one** slot, every later message still read its ~1,600-token prompt in 1.4 s;
rereading it from scratch takes ~4.6 s at the speed first messages were read. The waits agree (each
queued reply cost ~12 s, which only adds up if nobody's prompt was reread). So in this Ollama
version, a slot is not "one cached conversation"; how it keeps the others isn't something this
benchmark examined. (One 2-slot reply did take 7.4 s, close to a full reread, so eviction can still
happen; it just wasn't the norm.)

**Ollama's `prompt_eval_count` can't tell you about the cache.** It reports the whole prompt's length
whether or not it was cached (1,604 tokens on a cached second message). Use `prompt_eval_duration`.

## The decision: two slots

There is almost always one person using hearth, occasionally two. Two slots covers both:

- **One person:** the reply gets a slot and background work (memory extraction, summaries, titles)
  gets the other, so background jobs never make a reply wait. The cost is that a reply sharing the
  GPU with a background job runs at ~17 rather than ~23 tok/s while they overlap.
- **Two people:** both replies run at once, ~17 tok/s each, which is still faster than anyone reads.
  Background work waiting at that moment is preempted by hearth's scheduler and retried later.
- **A rare third person** waits about one reply (~12 s).

Four slots would cost another 1.1 GB and give a third and fourth person an instant start at ~11 tok/s
each. Nothing about it is bad; it just pays for a case that doesn't happen here. Since an idle slot
costs only memory, the rule for picking is **from memory and the most people you expect at once**,
not from hoping more slots means more speed: they don't.

## Caveats

- One run per cell. The direction of every effect is clear; individual numbers might move a few
  tok/s or seconds on another run (two users waited 7.7 s at 2 slots but 2.5 s at 4, where neither
  should have queued).
- Simulated users send messages back to back. Real people pause to read and type, so real
  contention is lower than this.
- Replies were capped at 256 tokens. Longer replies make queueing (with too few slots) worse in
  proportion.
- Measured with Ollama 0.33.3. Caching behaviour in particular has changed between Ollama versions;
  rerun the script after upgrading before relying on it.
