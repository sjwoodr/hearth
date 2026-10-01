import { describe, expect, it } from 'vitest';
import { SELF_CORRECTION, shouldThink } from './think-router.ts';

// Labelled from real use: the owner's messages on 2026-09-29 and the French bench's prompts, plus the
// everyday chat that must stay fast.
const NEEDS_THINKING: [string, string?][] = [
  ['What are the exceptions to the rule that "qui" usually comes before a verb ?'],
  ['Is this correct French? « La fille que chante est ma sœur. »'],
  ['Is « Je me suis levé tôt ce matin » correct? One sentence.'],
  ['i thought if the next word is a verb, it should be qui ??', 'Give me your answers and I\'ll tell you if you got them right.'],
  ['1) qui  2) qui 3) que', "1. Le garçon ___ j'ai parlé est mon cousin.\n2. La fille ___ chante\nGive me your answers and I'll tell you if you got them right."],
  ['Quiz me with three quick sentences where I have to pick qui or que.  (french)'],
  ['Can you check my French? « Hier je suis allé au marché. »'],
  ['Corrige: « Je suis allé à la plage avec mes amis hier soir. »'],
  ["Est-ce correct : « Je m'ai levé » ?"],
  ['Why is it « j\'y vais » but « je vais là-bas » ?'],
  ["What's the difference between malgré que and bien que?"],
  ['When do I use the subjunctive after « il faut que » ?'],
  ['Grade my answers: 1) qui 2) que'],
  ['Did I get this right? « Elle est partie sans dire au revoir. »'],
];

const STAYS_FAST: [string, string?][] = [
  ['Rough day. Spent three hours chasing a bug that turned out to be a typo. Talk me down.'],
  ["I'm thinking about getting back into ham radio contesting this winter. Any thoughts?"],
  ['What color would suit my radio shack? One sentence.'],
  ['And what was my druid called? One sentence.'],
  ['Tell me about Thomas Paine.'],
  ['Why did the Revolution start?'],
  ['hi'],
  ['Merci ! One word.'],
  ['Salut, ça va ?'],
  ['Explain how a Yagi antenna works, a few paragraphs.'],
  ['What was the weather like where I live this time of year?'],
  ['My dog Kaner has dry eye, any tips?'],
  ["Is it correct that Willie Mays played for the Giants?"],
  ['Give me one French idiom about rain, with its meaning. Two sentences.'],
  ['ok thanks', 'Here is how a Yagi works: ...'],
];

describe('deciding when to think', () => {
  it('thinks for grading, corrections, quizzes and grammar explanations', () => {
    const missed = NEEDS_THINKING.filter(([m, prev]) => !shouldThink(m, prev).think).map(([m]) => m);
    expect(missed).toEqual([]);
  });

  it('stays fast for everyday chat', () => {
    const fired = STAYS_FAST.filter(([m, prev]) => shouldThink(m, prev).think).map(([m, prev]) => [m, shouldThink(m, prev).reason]);
    expect(fired).toEqual([]);
  });

  it('says why it chose to think', () => {
    expect(shouldThink('Is « Je m\'ai levé » correct?').reason).toBe('checking your French');
    expect(shouldThink('1) qui 2) que', 'Fill the gap: « La fille ___ chante »').reason).toBe('grading quiz answers');
  });
});

describe('spotting a fast reply that corrected itself', () => {
  it('matches real self-corrections and not ordinary replies', () => {
    expect(SELF_CORRECTION.test("L'homme qui j'ai vu... (Wait, no—that's wrong. That would be que.)")).toBe(true);
    expect(SELF_CORRECTION.test("Actually, let's correct that thought: the real exception is…")).toBe(true);
    expect(SELF_CORRECTION.test('It\'s perfectly correct. You used the passé composé correctly.')).toBe(false);
    expect(SELF_CORRECTION.test('Actually, purple would look great in a radio shack.')).toBe(false);
  });
});
