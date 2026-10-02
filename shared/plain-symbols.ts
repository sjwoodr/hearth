// Gemma sometimes writes symbols as LaTeX ($\rightarrow$), which shows here as raw code. The system
// prompt asks it not to, and it still did in 3 of the first 115 replies. So known symbol commands are
// turned into plain characters: on the server before a reply is saved (so history doesn't teach the
// model the habit) and in the browser as it renders (for text still streaming in). Shared by both.

const SYMBOLS: Record<string, string> = {
  rightarrow: '→', to: '→', longrightarrow: '→', leftarrow: '←', longleftarrow: '←', gets: '←',
  leftrightarrow: '↔', Rightarrow: '⇒', Longrightarrow: '⇒', implies: '⇒', Leftarrow: '⇐',
  Leftrightarrow: '⇔', iff: '⇔', uparrow: '↑', downarrow: '↓', mapsto: '↦',
  neq: '≠', ne: '≠', leq: '≤', le: '≤', geq: '≥', ge: '≥', approx: '≈', sim: '~', equiv: '≡',
  times: '×', div: '÷', pm: '±', cdot: '·', infty: '∞', circ: '°', degree: '°',
  ldots: '…', dots: '…', cdots: '⋯', checkmark: '✓', bullet: '•', star: '⋆',
  in: '∈', notin: '∉', subset: '⊂', cup: '∪', cap: '∩', forall: '∀', exists: '∃', neg: '¬',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π',
  sigma: 'σ', Sigma: 'Σ', omega: 'ω', Omega: 'Ω',
};

// A short $…$ or \(…\) span holding at least one backslash command, on one line.
const MATH_SPAN = /\$([^$\n]{1,60}?)\$|\\\(([^\n]{1,60}?)\\\)/g;
const COMMAND = /\\([a-zA-Z]+)\b\s*/g;

function plainSpan(math: string): string | undefined {
  let unknown = false;
  const text = math.replace(COMMAND, (_, name: string) => {
    const symbol = SYMBOLS[name];
    if (symbol === undefined) unknown = true;
    return symbol === undefined ? '' : `${symbol} `;
  });
  // Only spans made of known commands; a dollar amount or real math is left as written.
  if (unknown || text === math) return undefined;
  return text.replace(/\^\s*°/g, '°').replace(/\s+/g, ' ').trim();
}

/** The text with LaTeX symbol markup outside code turned into plain characters. */
export function plainSymbols(text: string): string {
  if (!text.includes('\\')) return text;
  // Split out fenced blocks and inline code: LaTeX shown as code is meant literally.
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(MATH_SPAN, (span, a?: string, b?: string) => plainSpan(a ?? b ?? '') ?? span),
    )
    .join('');
}
