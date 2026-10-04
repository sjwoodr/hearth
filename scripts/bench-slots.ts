// Slot benchmark: how Ollama's OLLAMA_NUM_PARALLEL setting behaves with 1-4 people chatting at once.
// Talks to Ollama directly (not through hearth), with hearth's chat settings (num_ctx 16384, no
// thinking). Each simulated user has a conversation of its own, about 2.5k tokens long, and sends
// a few messages back to back; all users run at the same time.
//
// What to look for:
// - wait: time to the first word. Grows when there are more users than slots (Ollama queues).
// - tok/s: one reply's speed. Drops as more replies share the GPU.
// - total: all users' tokens per second together.
// - prompt s: time Ollama spent reading the prompt. A user's 1st message reads the whole chat (cold);
//   on later ones a short time means its cache still held that conversation, and a time near the
//   cold one means another user's chat evicted it. (Ollama's prompt_eval_count can't tell: it
//   reports the whole prompt's length either way.)
// - memory: what `ollama ps` reports for the model afterwards.
//
//   node scripts/bench-slots.ts [--users 1,2,3,4] [--turns 3] [--slots N]
//
// The slot count is read from the ollama service's environment (pass --slots if that fails).
// Results are printed and saved to data/bench/. Nothing else should be using the model meanwhile.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readLines, type StreamLine } from '../server/ollama.ts';

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.HEARTH_MODEL ?? 'gemma4:26b-a4b-it-qat';
const NUM_CTX = 16384;
const REPLY_TOKENS = 256;

const { values: args } = parseArgs({
  options: {
    users: { type: 'string', default: '1,2,3,4' },
    turns: { type: 'string', default: '3' },
    slots: { type: 'string' },
  },
});
const userCounts = args.users.split(',').map(Number);
const turns = Number(args.turns);

function serviceSlots(): string {
  try {
    const env = execFileSync('systemctl', ['show', 'ollama', '-p', 'Environment'], { encoding: 'utf8' });
    return /OLLAMA_NUM_PARALLEL=(\d+)/.exec(env)?.[1] ?? '1';
  } catch {
    return '?';
  }
}
const slots = args.slots ?? serviceSlots();

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

// Material for the made-up histories. Speed depends on token counts, not on what the text says,
// but it reads like a hearth chat so the replies are realistic in length.
const TOPICS = [
  'le passé composé avec être et avoir',
  "l'accord du participe passé",
  'le subjonctif après les expressions de sentiment',
  'les pronoms relatifs qui, que, dont et où',
  'la différence entre imparfait et passé composé',
  'le genre des noms qui finissent en -age et -tion',
  'les pronoms y et en',
  'le conditionnel pour la politesse',
];
const QUESTIONS = [
  'Can you explain this with three new examples and the most common mistake learners make?',
  'Give me a short paragraph in French using it, then translate it and point out each case.',
  'What are the exceptions I should memorise, and why do they behave differently?',
  'Quiz me: write five sentences with a blank each, then give the answers with explanations.',
];

function history(user: number, run: string): Message[] {
  const topic = TOPICS[user % TOPICS.length]!;
  const messages: Message[] = [
    {
      role: 'system',
      content:
        `Session ${run}-${user}. You are hearth, a patient French tutor for user ${user}. ` +
        `This user is studying ${topic}. Answer in English with French examples, be precise, ` +
        'and correct any French mistakes the user makes. '.repeat(4),
    },
  ];
  for (let i = 0; messages.length < 13; i++) {
    messages.push({ role: 'user', content: `Question ${i + 1} about ${topic}: ${QUESTIONS[i % QUESTIONS.length]}` });
    messages.push({
      role: 'assistant',
      content:
        `Voici l'explication numéro ${i + 1} sur ${topic}. ` +
        `Par exemple : « Hier, nous sommes allés au marché et nous avons acheté des pommes. » ` +
        `Here the auxiliary changes because of the verb, and the participle agrees with the subject. `.repeat(6) +
        `Remember the pattern for user ${user}: practise it daily, and write your own sentences.`,
    });
  }
  return messages;
}

type Turn = {
  user: number;
  turn: number;
  waitS: number; // request sent → first word
  seconds: number; // request sent → done
  promptTokens: number; // the whole prompt, cached or not
  promptS: number;
  tokens: number;
  tokPerS: number;
};

async function chat(messages: Message[], seed: number, maxTokens = REPLY_TOKENS) {
  const started = performance.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model: MODEL,
      messages,
      think: false,
      stream: true,
      options: { num_ctx: NUM_CTX, num_predict: maxTokens, seed },
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  let text = '';
  let firstAt = 0;
  let done: StreamLine = {};
  for await (const line of readLines(res.body)) {
    if (line.message?.content) {
      if (!firstAt) firstAt = performance.now();
      text += line.message.content;
    }
    if (line.done) done = line;
  }
  const ended = performance.now();
  return {
    text,
    waitS: ((firstAt || ended) - started) / 1000,
    seconds: (ended - started) / 1000,
    promptTokens: done.prompt_eval_count ?? 0,
    promptS: (done.prompt_eval_duration ?? 0) / 1e9,
    tokens: done.eval_count ?? 0,
    tokPerS: done.eval_count && done.eval_duration ? done.eval_count / (done.eval_duration / 1e9) : 0,
  };
}

async function simulateUser(user: number, run: string): Promise<Turn[]> {
  const messages = history(user, run);
  const results: Turn[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    messages.push({ role: 'user', content: `New question ${turn}: ${QUESTIONS[(user + turn) % QUESTIONS.length]} Use about 250 words.` });
    const { text, ...stats } = await chat(messages, user * 100 + turn);
    messages.push({ role: 'assistant', content: text });
    results.push({ user, turn, ...stats });
  }
  return results;
}

async function modelMemoryGB(): Promise<number> {
  const ps = (await (await fetch(`${OLLAMA}/api/ps`)).json()) as { models: { name: string; size: number }[] };
  return (ps.models.find((m) => m.name === MODEL)?.size ?? 0) / 1e9;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const fmt = (n: number, digits = 1) => n.toFixed(digits);

console.log(`Ollama ${OLLAMA}, ${MODEL}, OLLAMA_NUM_PARALLEL=${slots}; users ${userCounts.join(',')}, ${turns} messages each`);
const loadStarted = performance.now();
await chat([{ role: 'user', content: 'Bonjour' }], 1, 1);
console.log(`model ready in ${fmt((performance.now() - loadStarted) / 1000)} s (includes loading if it wasn't)\n`);

const run = Date.now().toString(36); // fresh conversations each run, so no cache carries over
const scenarios = [];
console.log('users  wait med/max  tok/s per reply  total tok/s  prompt s: 1st msg  later med/max  memory');
for (const users of userCounts) {
  const started = performance.now();
  const turnsDone = (await Promise.all(Array.from({ length: users }, (_, u) => simulateUser(u, `${run}-${users}`)))).flat();
  const wall = (performance.now() - started) / 1000;
  const later = turnsDone.filter((t) => t.turn > 1);
  const summary = {
    users,
    waitMedianS: median(turnsDone.map((t) => t.waitS)),
    waitMaxS: Math.max(...turnsDone.map((t) => t.waitS)),
    tokPerSMedian: median(turnsDone.map((t) => t.tokPerS)),
    totalTokPerS: turnsDone.reduce((sum, t) => sum + t.tokens, 0) / wall,
    firstPromptS: median(turnsDone.filter((t) => t.turn === 1).map((t) => t.promptS)),
    laterPromptSMedian: median(later.map((t) => t.promptS)),
    laterPromptSMax: Math.max(0, ...later.map((t) => t.promptS)),
    memoryGB: await modelMemoryGB(),
    wallS: wall,
  };
  scenarios.push({ ...summary, turns: turnsDone });
  console.log(
    `${String(users).padStart(5)}  ${fmt(summary.waitMedianS).padStart(5)} / ${fmt(summary.waitMaxS).padEnd(5)}` +
      `  ${fmt(summary.tokPerSMedian).padStart(15)}  ${fmt(summary.totalTokPerS).padStart(11)}` +
      `  ${fmt(summary.firstPromptS).padStart(16)}  ${fmt(summary.laterPromptSMedian).padStart(5)} / ${fmt(summary.laterPromptSMax).padEnd(5)}` +
      `  ${fmt(summary.memoryGB)} GB`,
  );
}
console.log(`\n(a user's first message reads its whole chat, ~${median(scenarios.flatMap((s) => s.turns.filter((t) => t.turn === 1).map((t) => t.promptTokens)))} tokens)`);

const dir = path.join(import.meta.dirname, '..', 'data', 'bench');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `slots-${slots}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify({ model: MODEL, numCtx: NUM_CTX, slots, turns, scenarios }, null, 2));
console.log(`saved ${path.relative(process.cwd(), file)}`);
