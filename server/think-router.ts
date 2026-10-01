// Decides, per message, whether a reply is worth thinking first. Plain rules, no model call: on
// this machine a separate classifier request would evict Ollama's cached conversation (one slot,
// OLLAMA_NUM_PARALLEL=1) and cost the next reply a full reread.
//
// The rules aim at what the French bench showed the fast model gets wrong: grading and correcting
// (it marked 4 of 20 right answers wrong), explaining exceptions, and writing quiz questions (both
// Gemma and Nemotron wrote broken ones). Ceiling: keyword rules miss rephrasings and can fire on
// look-alikes; the manual On/Off setting overrides them either way.

export type ThinkDecision = { think: boolean; reason?: string };

const CHECKING =
  /(«[^»]+»|"[^"]{8,}")[^?.!]{0,40}\b(correct|right|wrong|natural|ok|okay)\b|\b(is|was|are) (this|that|it|my|these) (\w+ )?(correct|right|ok|okay|wrong|natural|proper)\b|\bam i (right|correct|wrong)\b|\bdid i (get|say|write|do) (it|this|that)?\s*(right|correctly)?\b|\bcheck (my|this|these|the)\b|\bcorrect (my|this|these|me)\b|\bgrade (my|this|these|me)\b|\bfix (my|this)\b|\best-ce (que c'est |que ce soit )?(correct|juste|bon)\b|\bc'est (correct|juste|bon)\s*\?|\bcorrig(e|ez|er)\b|\bv[ée]rifi(e|ez|er)\b/i;

const QUIZ_REQUEST = /\b(quiz|test|drill)\s+me\b|\bgive me (an? |some |\d+ )?(exercise|exercises|quiz|practice|sentences to)\b|\binterroge-moi\b/i;

const WHY_OR_RULE =
  /\b(exceptions?|why (do|does|is|are|would|did|can't|isn't)|pourquoi|difference between|différence entre|when (do|should|would|can) (i|you|we|one) use|when to use|which (one )?is (right|correct)|the rule for)\b/i;

// Enough French to treat the question as about French: quoted French, or French function words.
const FRENCH_WORDS = /\b(le|la|les|un|une|des|du|de|je|tu|il|elle|nous|vous|ils|elles|que|qui|dont|où|est|sont|pas|ne|ce|se|au|aux|avec|pour|dans|sur|mais|et|ou|très|j'|l'|d'|qu'|c'est)\b/gi;
const aboutFrench = (text: string) =>
  /french|français|francais|grammar|grammaire|subjunctive|subjonctif|conjugat|pronoun|pronom|passé|imparfait|«|\b(qui|que|dont|qu'|ce qui|ce que)\b/i.test(text) ||
  (text.match(FRENCH_WORDS)?.length ?? 0) >= 4;

// A quiz from hearth: numbered items with gaps, or an invitation to answer.
const QUIZ_GIVEN = /_{2,}|\bpick (qui|que|one)\b|\bfill (in )?the (gap|blank)|give me your answers|\bchoose (the|between)\b/i;
// A short message that reads as answers: "1) qui 2) que", "qui, que, dont", a single word.
const looksLikeAnswers = (text: string) =>
  text.length <= 200 && (/^\s*\d+[).:]/.test(text) || /\b\d+[).:]\s*\S+/.test(text) || text.trim().split(/\s+/).length <= 6);

export function shouldThink(message: string, previousReply?: string): ThinkDecision {
  // "Is it correct that Willie Mays played for the Giants?" is a fact check, not a French check.
  if (CHECKING.test(message) && aboutFrench(message)) return { think: true, reason: 'checking your French' };
  if (previousReply && QUIZ_GIVEN.test(previousReply)) {
    if (looksLikeAnswers(message)) return { think: true, reason: 'grading quiz answers' };
    // Pushing back on a quiz ("I thought a verb meant qui?") needs the same care as the grading.
    if (aboutFrench(message)) return { think: true, reason: 'discussing quiz answers' };
  }
  if (QUIZ_REQUEST.test(message) && aboutFrench(message)) return { think: true, reason: 'writing quiz questions' };
  if (WHY_OR_RULE.test(message) && aboutFrench(message)) return { think: true, reason: 'explaining a grammar rule' };
  return { think: false };
}

/** A fast reply that corrected itself mid-answer: worth offering a re-answer with thinking. */
export const SELF_CORRECTION =
  /\b(wait,? no\b|that's (wrong|not right|incorrect)|let me correct (that|myself)|let's correct that|actually,? (no|that's wrong|scratch that)|scratch that|correction:)|non,? attends|en fait,? non/i;
