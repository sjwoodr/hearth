// Finds the word under a tap and the sentence around it, for the translation popup.

// Letters, joined by a hyphen or apostrophe: "l'ombre", "tire-bouchon", "aujourd'hui" are one tap.
const WORD = /[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*/gu;
const SENTENCE_END = /[.!?…]+["'»”)]*(?:\s+|$)|\n+/g;
export const MAX_SENTENCE_CHARS = 400;

/** The word at `offset` in `text`, with where it starts and ends, or undefined between words. */
export function wordAt(text: string, offset: number): { word: string; start: number; end: number } | undefined {
  for (const match of text.matchAll(WORD)) {
    const end = match.index + match[0].length;
    if (offset >= match.index && offset < end) return { word: match[0], start: match.index, end };
  }
  return undefined;
}

/** The sentence holding `offset`, cut to MAX_SENTENCE_CHARS around it. */
export function sentenceAt(text: string, offset: number): string {
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(SENTENCE_END)) {
    const after = match.index + match[0].length;
    if (after <= offset) start = after;
    else {
      end = match.index + match[0].trimEnd().length;
      break;
    }
  }
  if (end - start > MAX_SENTENCE_CHARS) {
    start = Math.max(start, offset - MAX_SENTENCE_CHARS / 2);
    end = Math.min(end, start + MAX_SENTENCE_CHARS);
  }
  return text.slice(start, end).trim();
}
