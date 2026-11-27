import { describe, expect, it } from 'vitest';
import { comingUpNote, mentionsComingUp } from './coming-up.ts';
import { timeNote } from './pause.ts';
import { call, NOW, setupApp, signIn, type TestApp } from './testing.ts';

describe('mentionsComingUp', () => {
  // The probe's failing messages first, then the shapes the rules are for.
  it.each([
    'I have to start getting ready for dinner in about 30 minutes.',
    "Show's at 8:30 so I'll need to head out in a bit. Still sitting on the porch for now.",
    "Dinner's at 7:30, so I've got about half an hour.",
    "We're in our seats for the show now, starts in about 10 minutes.",
    "I've got a dentist appointment in about 30 minutes, ugh.",
    'I have a call at 3, so maybe 40 minutes from now.',
    'Got about an hour before we meet for the tour briefing.',
    'Half an hour to go before the show.',
    'We have 20 minutes left before boarding.',
    'I need to head out in a few.',
    'Meeting at 2pm, but I have a little time.',
    'the 8:30 show tonight should be good',
    'I have to leave for work soon.',
    'Bed soon probably, but not yet.',
    "sleep isn't too far off for me",
    'Gotta go in a sec, my ride is here',
    'Leaving for the airport tomorrow morning.',
    'Have to get going before we lose the light.',
    'I’ve got about an hour before my flight.', // curly apostrophe
    // One per rule, matched by that rule alone:
    'I’ve got about an hour.', // curly apostrophe, "I've got"
    'sleep isn’t too far off', // curly apostrophe, "isn't far off"
    "We've got maybe twenty minutes.",
    'Dinner in a bit, but no rush.',
    'I should start getting ready for the party.',
    "We'll head out after this episode.",
    'Gotta run after this one.',
    'One more question before I go.',
    'Meeting at 2pm.',
    'a half hour to go',
  ])('yes: %s', (message) => {
    expect(mentionsComingUp(message)).toBe(true);
  });

  it.each([
    'Napped for an hour and feel human again.',
    'I finally fixed the node at 2am last night.',
    'I woke up at 6 and felt great.',
    'Took like 40 photos of the same sunset.',
    "I haven't played that game in a while.",
    'The build is at 3.2 now and the tests pass.',
    'My streak is at 214 days.',
    'I spent 3 hours debugging that race condition.',
    'Can you explain how tides work?',
    'Ok, heading to dinner now. Talk later!',
    'Good evening!',
    '',
  ])('no: %s', (message) => {
    expect(mentionsComingUp(message)).toBe(false);
  });
});

describe('comingUpNote', () => {
  it('names the person, in the wording that was measured', () => {
    expect(comingUpNote('Sam', 'Dinner in 30 minutes.')).toBe(
      "[Sam is still here and chatting. Whatever Sam has coming up, don't wrap up or say goodbye: Sam will say when they're going.]",
    );
  });

  it('is empty when nothing is coming up', () => {
    expect(comingUpNote('Sam', 'The mango here is unreal.')).toBe('');
  });
});

describe('the note in a reply prompt', () => {
  const PLANS = 'I have to start getting ready for dinner in about 30 minutes.';
  const say = async (app: TestApp, cookie: string, id: number, content: string) =>
    (await call(app, cookie, 'POST', `/conversations/${id}/messages`, { content })).text();

  it('rides on the newest message only, after the time note, and is never stored', async () => {
    const ctx = setupApp();
    const alice = await signIn(ctx, 'alice');
    const { id } = (await (await call(ctx.app, alice, 'POST', '/conversations')).json()) as { id: number };

    await say(ctx.app, alice, id, `Hi! ${PLANS}`);
    expect(ctx.model.calls.at(-1)!.at(-1)).toEqual({
      role: 'user',
      content: `${timeNote('alice', NOW)}\n${comingUpNote('alice', PLANS)}\n\n[alice's message]\nHi! ${PLANS}`,
    });

    await say(ctx.app, alice, id, PLANS);
    expect(ctx.model.calls.at(-1)!.at(-1)).toEqual({
      role: 'user',
      content: `${comingUpNote('alice', PLANS)}\n\n[alice's message]\n${PLANS}`,
    });

    // The next message mentions nothing: no note, and the earlier ones are in the history as written.
    await say(ctx.app, alice, id, 'The mango here is unreal.');
    const prompt = ctx.model.calls.at(-1)!;
    expect(prompt.at(-1)).toEqual({ role: 'user', content: 'The mango here is unreal.' });
    expect(prompt.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([`Hi! ${PLANS}`, PLANS, 'The mango here is unreal.']);

    const stored = ctx.db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id").all(id) as { content: string }[];
    expect(stored.map((m) => m.content)).toEqual([`Hi! ${PLANS}`, PLANS, 'The mango here is unreal.']);
  });

  it('rides on a private chat’s newest message too', async () => {
    const ctx = setupApp();
    const alice = await signIn(ctx, 'alice');
    const messages = [
      { role: 'user', content: 'Back home now.' },
      { role: 'assistant', content: 'How was the day?' },
      { role: 'user', content: PLANS },
    ];
    await (await call(ctx.app, alice, 'POST', '/private/a1b2c3d4-private/messages', { messages })).text();
    const prompt = ctx.model.calls.at(-1)!;
    expect(prompt.at(-1)).toEqual({ role: 'user', content: `${comingUpNote('alice', PLANS)}\n\n[alice's message]\n${PLANS}` });
    expect(prompt.at(-3)).toEqual({ role: 'user', content: 'Back home now.' });
  });
});
