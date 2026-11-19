import { useEffect } from 'react';
import { voiceLabel, type SpeechLanguage } from '../../shared/speech.ts';
import { speechState, stopSpeaking, toggleSpeaking, useSpeech } from './speech.ts';

export const SpeakerIcon = () => (
  <svg viewBox="2 4 20 16" width="18" height="15" aria-hidden="true" className="speaker-icon">
    <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const StopIcon = () => (
  <svg viewBox="2 4 20 16" width="18" height="15" aria-hidden="true" className="speaker-icon">
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" />
  </svg>
);

/**
 * Plays `text()` aloud in the user's voices (French sentences in the French one, the rest in the
 * English), or all of it in `language`'s; or stops it. Nothing shows when the server can't read
 * aloud. What it started stops if it goes away (another chat opened, the popup closed).
 */
export function SpeakButton({
  id,
  text,
  label,
  language,
  children,
}: {
  id: string;
  text: () => string;
  label: string;
  language?: SpeechLanguage;
  children?: string;
}) {
  const speech = useSpeech();
  const on = speech.playing === id;
  useEffect(
    () => () => {
      // What's playing when the button goes away, not when it last rendered.
      if (speechState().playing === id) stopSpeaking();
    },
    [id],
  );
  if (!speech.available) return null;
  const failed = speech.failed?.key === id ? speech.failed.message : null;
  return (
    <>
      <button
        type="button"
        className={`icon speak${on ? ' on' : ''}${on && speech.waiting ? ' waiting' : ''}${children ? ' with-label' : ''}`}
        aria-label={on ? 'Stop reading aloud' : label}
        aria-pressed={on}
        title={on ? 'Stop' : language ? `${label} (${voiceLabel(speech.chosen[language])})` : label}
        onClick={() => toggleSpeaking(id, text(), language)}
      >
        {on ? <StopIcon /> : <SpeakerIcon />}
        {children && <span>{children}</span>}
      </button>
      {failed && (
        <span className="speak-error" role="status">
          {failed}
        </span>
      )}
    </>
  );
}
