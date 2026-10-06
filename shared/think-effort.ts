// How hard a thinking reply may think: each level is a cap on reasoning tokens (HEARTH_THINKING_TOKEN_BUDGET,
// _HIGH and _MAX; 200, 400 and 800 by default). Medium is the measured default: 200 tokens kept all of
// unlimited thinking's accuracy on the French grading bench. High and Max are for harder questions;
// each doubles the worst-case wait (~9, ~18, ~36 s of reasoning at ~22 tok/s).

export const EFFORTS = ['medium', 'high', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const EFFORT_LABEL: Record<Effort, string> = { medium: 'Medium', high: 'High', max: 'Max' };

export const isEffort = (value: unknown): value is Effort => EFFORTS.includes(value as Effort);

/** The next level up, or undefined at Max. */
export const higherEffort = (effort: Effort): Effort | undefined => EFFORTS[EFFORTS.indexOf(effort) + 1];
