// "I have to start getting ready for dinner in about 30 minutes": a note on the newest message that the
// person is still here. Told they'd need to get ready or head out soon, the model wrapped the chat up
// ("I'll let you get your things sorted… I'll be here whenever you're back") although they kept writing.
// Rules in the system prompt didn't help, and every wording that named the situation made it worse; this
// note took it from 12 in 20 to 0 in 20 while real goodbyes still got one (CLAUDE.md, "Plans coming up").
// Keyword rules, no model call, like Think: Auto. Like the time note, it rides on the newest message only.

const NUMBER = String.raw`(?:\d+|an?|one|two|three|four|five|ten|fifteen|twenty|thirty|forty(?:[- ]five)?|a half|a few|a couple(?: of)?)`;
const DURATION = String.raw`${NUMBER}\s*(?:-\s*)?(?:min(?:ute)?s?|hours?|hrs?)\b`;
const ROUGHLY = String.raw`(?:about |around |like |maybe |roughly |under |less than |another |just |only )?`;

/** Time left before something: "in about 30 minutes", "half an hour to go", "I've got an hour". */
const TIME_LEFT = [
  new RegExp(String.raw`\bin ${ROUGHLY}${DURATION}`, 'i'),
  new RegExp(String.raw`\b${DURATION} (?:from now|to go|left|until|till|til|before)\b`, 'i'),
  new RegExp(String.raw`\b(?:i'?ve|we'?ve|i|we) (?:got|have) ${ROUGHLY}${DURATION}`, 'i'),
  /\bin a (?:bit|few|little(?: bit)?|sec(?:ond)?|minute)\b/i,
];

/** A clock time ("dinner's at 7:30", "the 8:30 show", "a call at 3"), unless the message is about the past. */
const CLOCK = /\bat \d{1,2}(?::\d{2})?(?![.,]?\d)|\b\d{1,2}:\d{2}\b/i;
const PAST = /\b(?:last night|yesterday|ago|earlier|this morning|woke|got up|went to bed|fell asleep)\b/i;

/** Getting ready or leaving: "get ready", "head out", "have to go", "bed soon", "sleep isn't far off". */
const LEAVING = [
  /\b(?:get|getting) ready\b/i,
  /\bhead(?:ing)? (?:out|off|over|down)\b/i,
  /\b(?:have|need|got) to (?:go|leave|head|run|get going|get moving|log off|be (?:somewhere|there))\b/i,
  /\bgotta (?:go|run|head|leave|get going|bounce)\b/i,
  /\b(?:leave|leaving) (?:for|in|at|soon|shortly)\b/i,
  /\bbefore (?:i|we) (?:go|leave|head)\b/i,
  /\b(?:go|going|head|heading|leave|leaving|bed|sleep|dinner|lunch|work|class|call|meeting|appointment|flight|show)\b[^.?!]{0,30}\bsoon\b/i,
  /\b(?:not|isn'?t) (?:too |that )?far off\b/i,
];

/** True when the message says something is coming up that they'll go to: a time left, a clock time or leaving. */
export function mentionsComingUp(message: string): boolean {
  const text = message.replace(/[‘’]/g, "'");
  if (TIME_LEFT.some((re) => re.test(text)) || LEAVING.some((re) => re.test(text))) return true;
  return CLOCK.test(text) && !PAST.test(text);
}

/** The note for a newest message that mentions something coming up, or ''. */
export function comingUpNote(name: string, message: string): string {
  if (!mentionsComingUp(message)) return '';
  return `[${name} is still here and chatting. Whatever ${name} has coming up, don't wrap up or say goodbye: ${name} will say when they're going.]`;
}
