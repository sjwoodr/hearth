import { useEffect, useRef, useState, type ComponentProps } from 'react';
import Markdown, { type ExtraProps, type Options } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

/**
 * Copies text to the clipboard. `navigator.clipboard` only exists in a secure context (HTTPS or
 * localhost), so on a plain-HTTP LAN address this falls back to the older selection-based copy.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

/** The language a fenced block was tagged with (```python), from its <code> child's class. */
function languageOf(node: ExtraProps['node']): string | undefined {
  const code = node?.children[0];
  if (code?.type !== 'element') return undefined;
  const classes = code.properties.className;
  const tag = Array.isArray(classes) ? classes.find((c) => String(c).startsWith('language-')) : undefined;
  return tag ? String(tag).slice('language-'.length) : undefined;
}

/** A fenced code block: highlighted (by rehype-highlight), with its language and a copy button. */
function CodeBlock({ node, children, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const language = languageOf(node);
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-language">{language ?? 'code'}</span>
        <button
          type="button"
          className="link"
          aria-label={copied === null ? (language ? `Copy ${language} code` : 'Copy code') : undefined}
          // The text as shown, without the newline Markdown ends every block with.
          onClick={async () => setCopied(await copyText((ref.current?.textContent ?? '').replace(/\n$/, '')))}
        >
          {copied === null ? 'Copy' : copied ? 'Copied' : "Couldn't copy"}
        </button>
      </div>
      <pre ref={ref} {...props}>
        {children}
      </pre>
    </div>
  );
}

const components = {
  a: ({ node: _node, ...props }: ComponentProps<'a'> & ExtraProps) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  pre: CodeBlock,
};

// The highlighter (highlight.js's 37 common languages) is over half again the size of the rest of the
// app, so it loads the first time a message has a code fence. Only blocks tagged with a language are
// highlighted (rehype-highlight's default): guessing gets short snippets wrong.
type Plugins = NonNullable<Options['rehypePlugins']>;
const NONE: Plugins = [];
let highlighter: Plugins | null = null;
let loadingHighlighter: Promise<void> | null = null;

function useHighlighter(needed: boolean): Plugins {
  const [, setLoaded] = useState(false);
  useEffect(() => {
    if (!needed || highlighter) return;
    let live = true;
    loadingHighlighter ??= import('rehype-highlight').then((m) => {
      highlighter = [m.default];
    });
    // A failed load leaves code plain; the next fenced message tries again.
    loadingHighlighter.then(
      () => live && setLoaded(true),
      () => (loadingHighlighter = null),
    );
    return () => {
      live = false;
    };
  }, [needed]);
  return needed && highlighter ? highlighter : NONE;
}

const replyPlugins = [remarkGfm];
// What someone typed keeps its line breaks, as a chat should; Markdown would otherwise join single lines.
const typedPlugins = [remarkGfm, remarkBreaks];

/** A message's Markdown, rendered. `typed`: written by a person (keeps single line breaks). */
export function MessageMarkdown({ text, typed = false }: { text: string; typed?: boolean }) {
  const rehypePlugins = useHighlighter(text.includes('```') || text.includes('~~~'));
  return (
    <Markdown remarkPlugins={typed ? typedPlugins : replyPlugins} rehypePlugins={rehypePlugins} components={components}>
      {text}
    </Markdown>
  );
}
