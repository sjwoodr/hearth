// A message that starts with "[no extraction]" is kept out of everything hearth learns or builds from
// a chat: memory extraction (about the user and about the assistant), the chat's summary, titles and
// search. Its reply is too. The message is still saved and shown in its chat. Shared so the chat box
// can say so before sending and show the message without the marker straight away.

/** The marker, at the very start: any case, with a space, hyphen or underscore or nothing between. */
const MARKER = /^\s*\[\s*no[\s_-]*extraction\s*\]\s*/i;

/** The text without a leading marker, and whether it had one. */
export function parseNoExtraction(text: string): { content: string; noExtraction: boolean } {
  const match = MARKER.exec(text);
  return match ? { content: text.slice(match[0].length), noExtraction: true } : { content: text, noExtraction: false };
}

/** What the label and the chat box's hint say about such a message. */
export const NO_EXTRACTION_LABEL = 'Not remembered';
export const NO_EXTRACTION_HELP =
  "hearth won't learn anything from this message or its reply, and leaves both out of search, chat titles and the chat's summary. They stay in this chat.";
