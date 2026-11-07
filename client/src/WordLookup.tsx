import { useEffect, useRef, useState, type RefObject } from 'react';
import { sentenceAt, wordAt } from '../../shared/tapped-word.ts';
import { api, type WordMeaning } from './api.ts';

const POPUP_WIDTH = 260;
const SELECTION_PAUSE_MS = 500;
const MAX_TAP_MS = 500;
const MAX_TAP_MOVE = 10;
const MAX_SELECTION_CHARS = 120;
const BLOCKS = 'p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6';
// Links, buttons and code keep their own behavior.
const SKIP = 'a, button, pre, code, .sources';

type Box = { left: number; top: number; bottom: number };
type Popup = { text: string; box: Box; meaning?: WordMeaning; error?: string };

// Shortcut: kept for the page's lifetime and never trimmed, which is fine at a few bytes a word.
const meanings = new Map<string, WordMeaning>();

type Caret = { node: Text; offset: number };

/** The text position under a point. Firefox has caretPositionFromPoint; Safari only the older caretRangeFromPoint. */
function caretAt(x: number, y: number): Caret | undefined {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  const range = position ? undefined : doc.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? range?.startContainer;
  const offset = position?.offset ?? range?.startOffset ?? 0;
  return node instanceof Text ? { node, offset } : undefined;
}

/** The block's text and where `node`/`offset` falls in it, or undefined outside a reply's prose. */
function placeInBlock(node: Node, offset: number) {
  const parent = node instanceof Element ? node : node.parentElement;
  if (!parent?.closest('.message.assistant') || parent.closest(SKIP)) return undefined;
  const block = parent.closest(BLOCKS);
  if (!block) return undefined;
  const before = document.createRange();
  before.selectNodeContents(block);
  before.setEnd(node, offset);
  return { text: block.textContent ?? '', at: before.toString().length };
}

/** What a tap landed on: the word and its sentence, or undefined if it wasn't on a word. */
function tappedWord(x: number, y: number) {
  const caret = caretAt(x, y);
  if (!caret) return undefined;
  const found = wordAt(caret.node.data, Math.min(caret.offset, caret.node.length - 1));
  const place = placeInBlock(caret.node, caret.offset);
  if (!found || !place) return undefined;
  const range = document.createRange();
  range.setStart(caret.node, found.start);
  range.setEnd(caret.node, found.end);
  const rect = range.getBoundingClientRect();
  // A tap in the margin still finds the nearest text, so check it really hit the word.
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return undefined;
  return { text: found.word, sentence: sentenceAt(place.text, place.at), box: rect };
}

/** The selected phrase in one reply and its sentence, or undefined if there's nothing to look up. */
function selectedPhrase() {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return undefined;
  const text = selection.toString().replace(/\s+/g, ' ').trim();
  const range = selection.getRangeAt(0);
  if (!/\p{L}/u.test(text) || text.length > MAX_SELECTION_CHARS) return undefined;
  const place = placeInBlock(range.startContainer, range.startOffset);
  const message = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('.message');
  if (!place || message(range.startContainer) !== message(range.endContainer)) return undefined;
  return { text, sentence: sentenceAt(place.text, place.at), box: range.getBoundingClientRect() };
}

/** Tap a word in a reply, or select a phrase, for what it means there. Sits beside the messages it watches. */
export function WordLookup({ scroller }: { scroller: RefObject<HTMLDivElement | null> }) {
  const [popup, setPopup] = useState<Popup | null>(null);
  const shown = useRef<HTMLDivElement>(null);
  const latest = useRef(0);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const close = () => {
      latest.current += 1;
      setPopup(null);
    };
    const open = async (text: string, sentence: string, rect: DOMRect) => {
      const id = ++latest.current;
      const box = { left: rect.left, top: rect.top, bottom: rect.bottom };
      const key = `${text}\n${sentence}`;
      const known = meanings.get(key);
      setPopup({ text, box, meaning: known });
      if (known) return;
      try {
        const meaning = await api.lookupWord(text, sentence);
        meanings.set(key, meaning);
        if (id === latest.current) setPopup({ text, box, meaning });
      } catch (err) {
        if (id === latest.current) setPopup({ text, box, error: err instanceof Error ? err.message : "Couldn't look that up." });
      }
    };
    // Pointer events, not click: phones don't reliably send a click for plain text. A tap is a press
    // that stayed put and was short: a scroll cancels the pointer, and a long press is for selecting.
    let press: { x: number; y: number; at: number } | undefined;
    const onDown = (e: PointerEvent) => {
      press = e.isPrimary ? { x: e.clientX, y: e.clientY, at: e.timeStamp } : undefined;
    };
    const onCancel = () => {
      press = undefined;
    };
    const onUp = (e: PointerEvent) => {
      const start = press;
      press = undefined;
      if (!start || e.timeStamp - start.at > MAX_TAP_MS || Math.hypot(e.clientX - start.x, e.clientY - start.y) > MAX_TAP_MOVE) return;
      if (!document.getSelection()?.isCollapsed) return;
      const hit = tappedWord(e.clientX, e.clientY);
      if (hit) void open(hit.text, hit.sentence, hit.box);
      else close();
    };
    // After a pause, so dragging a selection out doesn't look up every step of the way.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onSelection = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const hit = selectedPhrase();
        if (hit) void open(hit.text, hit.sentence, hit.box);
      }, SELECTION_PAUSE_MS);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const onOutside = (e: PointerEvent) => {
      if (!el.contains(e.target as Node) && !shown.current?.contains(e.target as Node)) close();
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('scroll', close, { passive: true });
    document.addEventListener('selectionchange', onSelection);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside);
    return () => {
      clearTimeout(timer);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('scroll', close);
      document.removeEventListener('selectionchange', onSelection);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
    };
  }, [scroller]);

  if (!popup) return null;
  const { box, text, meaning, error } = popup;
  const left = Math.max(8, Math.min(box.left, window.innerWidth - POPUP_WIDTH - 8));
  // Below the word, or above it near the bottom of the screen.
  const position = box.bottom + 110 < window.innerHeight ? { top: box.bottom + 6 } : { bottom: window.innerHeight - box.top + 6 };
  return (
    <div ref={shown} className="word-popup" role="status" style={{ left, width: POPUP_WIDTH, ...position }}>
      <p className="word-popup-text" lang="fr">{text}</p>
      {meaning ? (
        <>
          <p className="word-popup-meaning">{meaning.translation}</p>
          {meaning.note && <p className="word-popup-note" lang="fr">{meaning.note}</p>}
        </>
      ) : (
        <p className="word-popup-note">{error ?? 'Looking it up…'}</p>
      )}
    </div>
  );
}
