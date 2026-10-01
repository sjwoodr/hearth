import type { ChatMessage } from './ollama.ts';

// Ceiling: a character-count estimate, not the model's tokenizer. ~3.5 chars per token
// errs toward over-counting English, so trimming happens slightly early rather than late.
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5) + 4;

/**
 * The system prompt plus as much recent history as fits in `budget` tokens. Oldest
 * messages drop first; the latest message is always kept. Trimming here, rather than
 * letting Ollama truncate, guarantees the system prompt survives.
 */
export function fitHistory(system: string, history: ChatMessage[], budget: number): ChatMessage[] {
  let used = estimateTokens(system);
  const kept: ChatMessage[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    const cost = estimateTokens(message.content);
    if (used + cost > budget && kept.length > 0) break;
    used += cost;
    kept.unshift(message);
  }
  return [{ role: 'system', content: system }, ...kept];
}
