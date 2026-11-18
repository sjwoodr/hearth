// How much memory a reply can carry, shared so the server (memoryContext) and the Memories page agree.
// Always-remembered memories, about the user and about the assistant, are taken from the allowance
// first; recalled ones get what's left (up to 6 about the user, 3 about the assistant).

/** hearth's token estimate: characters, not the model's tokenizer. ~3.5 per token over-counts English a little. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5) + 4;

/** Tokens of memories per reply, out of the context budget. */
export const MEMORY_BUDGET_TOKENS = 800;

/** Room recall needs: about six memories of 100-150 characters. Always-remembered past the rest crowds it. */
export const RECALL_ROOM_TOKENS = 230;

/** The allowance in characters, for people: what the tokens come to in plain text. */
export const MEMORY_BUDGET_CHARS = Math.round(MEMORY_BUDGET_TOKENS * 3.5);

export type AlwaysUse = { chars: number; state: 'ok' | 'crowding' | 'over' };

/**
 * What the always-remembered memories (both subjects together) use of the allowance. Past it, some are
 * left out of chats (memoryContext skips what doesn't fit); before that, past the room recall needs,
 * fewer recalled memories fit.
 */
export function alwaysUse(contents: string[]): AlwaysUse {
  const tokens = contents.reduce((n, c) => n + estimateTokens(c), 0);
  const chars = contents.reduce((n, c) => n + c.length, 0);
  const state = tokens > MEMORY_BUDGET_TOKENS ? 'over' : tokens > MEMORY_BUDGET_TOKENS - RECALL_ROOM_TOKENS ? 'crowding' : 'ok';
  return { chars, state };
}
