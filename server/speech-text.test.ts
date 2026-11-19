import { describe, expect, it } from 'vitest';
import {
  pcm16Decoder,
  readWavHeader,
  sortVoices,
  speechLanguage,
  speechParts,
  speechText,
  SPEECH_CHUNK_CHARS,
  voiceLabel,
  type SpeechLanguage,
} from '../shared/speech.ts';

// The pieces' text, read all in one language so only the cutting is tested.
const speechChunks = (text: string, max?: number) => speechParts(text, { max, language: 'french' }).map((p) => p.text);

describe('speechText', () => {
  it('reads prose as written, French and all', () => {
    expect(speechText("C'est « la boulangerie » du coin.\n\nOn y va ?")).toBe("C'est « la boulangerie » du coin.\n\nOn y va ?");
  });

  it('leaves code blocks out entirely, either fence, and keeps what follows', () => {
    const reply = 'Run this:\n\n```bash\nls -la\necho "hi"\n```\n\nThen this:\n~~~\nrm x\n~~~\nDone.';
    expect(speechText(reply)).toBe('Run this:\n\nThen this:\nDone.');
  });

  it('leaves an unclosed code block out to the end', () => {
    expect(speechText('Before.\n```\ncode\nmore code')).toBe('Before.');
  });

  it('reads links by their text and drops bare addresses and images', () => {
    expect(speechText('See [the tour dates](https://example.com/tour) or https://example.com/x for more. ![a cat](cat.png)')).toBe(
      'See the tour dates or for more.',
    );
  });

  it('drops markup: headings, quotes, list markers, emphasis, inline code, strikethrough, tags', () => {
    const reply = [
      '## Le passé composé',
      '> **Attention** : *être* ou _avoir_ ?',
      '- `je suis allé`',
      '2. ~~je ai~~ j’ai',
      'Un <b>mot</b>.',
    ].join('\n');
    expect(speechText(reply)).toBe(['Le passé composé', 'Attention : être ou avoir ?', 'je suis allé', 'je ai j’ai', 'Un mot.'].join('\n'));
  });

  it('keeps underscores and asterisks inside words, and arithmetic', () => {
    expect(speechText('snake_case_name and 2 * 3 * 4')).toBe('snake_case_name and 2 * 3 * 4');
  });

  it('reads a table row by row as its cells, without the rule line', () => {
    expect(speechText('| Pronom | Être |\n|---|:---:|\n| je | suis |')).toBe('Pronom, Être\n\nje, suis');
  });

  it('turns arrows into a pause and leaves emoji and LaTeX symbol markup out', () => {
    expect(speechText('je mange → nous mangeons 😊👍🏽 🇫🇷')).toBe('je mange, nous mangeons');
    expect(speechText('aller $\\rightarrow$ allé')).toBe('aller, allé');
  });
});

describe('speechParts: cutting', () => {
  it('keeps a short reply in one piece, a line without punctuation getting a full stop', () => {
    expect(speechChunks('Bonjour !\nÇa va')).toEqual(['Bonjour ! Ça va.']);
  });

  it('skips lines with nothing to say', () => {
    expect(speechChunks('\n---\n...\n\nOui.')).toEqual(['Oui.']);
  });

  it('packs whole sentences up to the limit, never past it, losing nothing', () => {
    const sentences = Array.from({ length: 12 }, (_, i) => `Phrase numéro ${i + 1} : elle parle du marché et des pommes.`);
    const text = sentences.join(' ');
    const chunks = speechChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SPEECH_CHUNK_CHARS);
      expect(chunk).toMatch(/\.$/); // every piece ends on a sentence
    }
    expect(chunks.join(' ')).toBe(text);
  });

  it('cuts an overlong sentence at its commas, then at spaces', () => {
    const clause = 'et puis nous sommes allés au marché';
    const sentence = `${Array.from({ length: 12 }, () => clause).join(', ')}.`;
    const chunks = speechChunks(sentence, 100);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
    expect(chunks.join(' ')).toBe(sentence);
    const words = speechChunks(`${'mot '.repeat(60).trim()}.`, 50);
    for (const chunk of words) expect(chunk.length).toBeLessThanOrEqual(50);
    expect(words.join(' ')).toBe(`${'mot '.repeat(60).trim()}.`);
  });

  it('cuts a single word longer than the limit', () => {
    const chunks = speechChunks('a'.repeat(250), 100);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 51]);
  });
});

describe('speechLanguage', () => {
  const said = (sentences: string[]) => sentences.map((s) => [s, speechLanguage(s)]);

  it('knows English from French by the words only one of them uses', () => {
    const english = [
      "That's a great question.",
      "It's a bit of a race against time, isn't it?",
      'You wrote « je va », but it should be « je vais ».',
      'I love that café on the corner.',
      "Let's practice: how do you say 'I went to the market'?",
      "Don't worry, it isn't hard.", // n't isn't an elision
      'AI is changing how people learn languages.',
    ];
    const french = [
      "C'est une excellente question.",
      'Tu as raison, c’est plus simple comme ça.',
      'On y va ?',
      'Je m’appelle Gemma.',
      "Correction : « J'ai allé », « Je suis allé »",
      'Bonjour !',
      'Merci.',
      'Parfait !',
      'Bonne nuit, Steve !',
      "Qu'importe l'avis.", // elisions alone
      'J’adore l’histoire.', // and with a phone's apostrophes
      'Idée géniale !', // accents alone
    ];
    expect(said(english)).toEqual(english.map((s) => [s, 'english']));
    expect(said(french)).toEqual(french.map((s) => [s, 'french']));
  });

  it("can't tell from a name, a number or a word both languages share", () => {
    for (const s of ['Marie.', '2026.', 'Bravo !', 'Super.', 'Steve, Paris, Montreal']) {
      expect(speechLanguage(s)).toBeUndefined();
    }
  });
});

describe('speechParts: languages', () => {
  const read = (text: string, language?: SpeechLanguage) => speechParts(text, { language }).map((p) => `${p.language}: ${p.text}`);

  it('reads each sentence in its own language, packing neighbours of the same one', () => {
    expect(read("Great job! Here's the correction:\nJe suis allé au marché. Tu progresses bien.\nYou need être with aller.")).toEqual([
      "english: Great job! Here's the correction:",
      'french: Je suis allé au marché. Tu progresses bien.',
      'english: You need être with aller.',
    ]);
  });

  it('gives a sentence with no sign of either the language before it', () => {
    expect(read('Tu as bien travaillé. Bravo ! Marie aussi.\nThat is right. Bravo!')).toEqual([
      'french: Tu as bien travaillé. Bravo ! Marie aussi.',
      'english: That is right. Bravo!',
    ]);
  });

  it("starts with the text's own language when the first sentence gives none", () => {
    expect(read('Bravo ! Tu as raison, et je suis content.')).toEqual(['french: Bravo ! Tu as raison, et je suis content.']);
    expect(read('Marie. She is right, and I am glad.')).toEqual(['english: Marie. She is right, and I am glad.']);
    expect(read('Marie.')).toEqual(['english: Marie.']);
  });

  it("keeps a quoted French sentence whole, closing quote and all", () => {
    expect(read('« Je suis allé au marché. » means I went to the market.')).toEqual([
      'french: « Je suis allé au marché. »',
      'english: means I went to the market.',
    ]);
  });

  it('never sends a piece with nothing to say, which the server would refuse', () => {
    expect(speechParts('Oui. ... !!! Non. »', { max: 4 }).map((p) => p.text)).toEqual(['Oui.', 'Non.']);
  });

  it('reads it all in one language when told to (a word from the popup)', () => {
    expect(read('market', 'french')).toEqual(['french: market.']);
    expect(read("C'est bon. That's good.", 'english')).toEqual(["english: C'est bon. That's good."]);
  });

  it('never packs two languages into one piece, or a piece past the limit', () => {
    const text = Array.from({ length: 30 }, (_, i) => (i % 3 ? `Je suis allé au marché ${i} fois.` : `I went there ${i} times.`)).join(' ');
    const parts = speechParts(text);
    for (const p of parts) {
      expect(p.text.length).toBeLessThanOrEqual(SPEECH_CHUNK_CHARS);
      expect(speechLanguage(p.text)).toBe(p.language);
    }
    expect(parts.map((p) => p.text).join(' ')).toBe(text);
    for (let i = 1; i < parts.length; i++) {
      if (parts[i]!.language === parts[i - 1]!.language) expect(parts[i - 1]!.text.length + 1 + parts[i]!.text.length).toBeGreaterThan(SPEECH_CHUNK_CHARS);
    }
  });
});

describe('voices', () => {
  it('names a voice by its language, then female or male', () => {
    expect(voiceLabel('female-french')).toBe('French, female');
    expect(voiceLabel('male-american-english')).toBe('American English, male');
    expect(voiceLabel('default')).toBe("Default (the model's own)");
    expect(voiceLabel('robot')).toBe('robot');
  });

  it("orders them the model's own first, then by language", () => {
    expect(sortVoices(['male-french', 'female-german', 'default', 'female-french', 'female-american-english'])).toEqual([
      'default',
      'female-american-english',
      'female-french',
      'male-french',
      'female-german',
    ]);
  });
});

/** A WAV header as Ollama streams it: 16-bit PCM, length fields left at 0xFFFFFFFF. */
function wavHeader(opts: { rate?: number; channels?: number; bits?: number; encoding?: number; extra?: Uint8Array } = {}) {
  const extra = opts.extra ?? new Uint8Array(0);
  const b = new Uint8Array(44 + extra.length);
  const v = new DataView(b.buffer);
  const put = (at: number, s: string) => [...s].forEach((ch, i) => (b[at + i] = ch.charCodeAt(0)));
  put(0, 'RIFF');
  v.setUint32(4, 0xffffffff, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, opts.encoding ?? 1, true);
  v.setUint16(22, opts.channels ?? 1, true);
  v.setUint32(24, opts.rate ?? 24000, true);
  v.setUint16(34, opts.bits ?? 16, true);
  b.set(extra, 36);
  put(36 + extra.length, 'data');
  v.setUint32(40 + extra.length, 0xffffffff, true);
  return b;
}

describe('readWavHeader', () => {
  it('reads the format and where the samples start, ignoring the placeholder lengths', () => {
    expect(readWavHeader(wavHeader())).toEqual({ sampleRate: 24000, channels: 1, dataOffset: 44 });
  });

  it('waits for more bytes rather than guessing', () => {
    const head = wavHeader();
    for (const n of [0, 11, 20, 30, 43]) expect(readWavHeader(head.subarray(0, n))).toBeUndefined();
  });

  it('skips chunks it has no use for', () => {
    const list = new Uint8Array([...'LIST'].map((c) => c.charCodeAt(0)).concat([4, 0, 0, 0, 1, 2, 3, 4]));
    expect(readWavHeader(wavHeader({ extra: list }))).toEqual({ sampleRate: 24000, channels: 1, dataOffset: 56 });
  });

  it('refuses anything but 16-bit PCM WAV', () => {
    expect(() => readWavHeader(new TextEncoder().encode('{"error":"model not found"}'))).toThrow('not a WAV');
    expect(() => readWavHeader(wavHeader({ bits: 8 }))).toThrow('16-bit');
    expect(() => readWavHeader(wavHeader({ encoding: 3 }))).toThrow('16-bit');
  });
});

describe('pcm16Decoder', () => {
  const bytes = (...samples: number[]) => {
    const b = new Uint8Array(samples.length * 2);
    samples.forEach((s, i) => new DataView(b.buffer).setInt16(i * 2, s, true));
    return b;
  };

  it('scales samples to -1..1', () => {
    expect([...pcm16Decoder(1)(bytes(0, 16384, -32768, 32767))]).toEqual([0, 0.5, -1, 32767 / 32768]);
  });

  it('holds a sample split across two pieces until the rest arrives', () => {
    const decode = pcm16Decoder(1);
    const all = bytes(100, -200, 300);
    expect([...decode(all.subarray(0, 3))]).toEqual([100 / 32768]);
    expect([...decode(all.subarray(3, 5))]).toEqual([-200 / 32768]);
    expect([...decode(all.subarray(5))]).toEqual([300 / 32768]);
  });

  it('mixes stereo down to one channel', () => {
    expect([...pcm16Decoder(2)(bytes(16384, 0, -16384, -16384))]).toEqual([0.25, -0.5]);
  });
});
