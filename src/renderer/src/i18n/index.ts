import { useEffect, useState } from 'react';
import { en, type Key } from './en';
import { vi } from './vi';

export type { Key };

/**
 * Lightweight i18n. To add a language:
 *   1. copy `vi.ts` to `<code>.ts` and translate every value,
 *   2. register it in `DICTS` and `LANGS` below.
 * Missing keys fall back to English.
 */
const DICTS = { en, vi } as const;
export type Lang = keyof typeof DICTS;

export const LANGS: { id: Lang; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'vi', name: 'Tiếng Việt' },
];

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('lang');
    if (saved && saved in DICTS) return saved as Lang;
  } catch {
    /* storage unavailable */
  }
  return 'en'; // English is the default for everyone
}

let lang: Lang = initialLang();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return lang;
}

/** Translate a key, replacing `{name}` placeholders with values from `params`. */
export function t(key: Key, params?: Record<string, string | number>): string {
  let s: string = (DICTS[lang] as Record<string, string>)[key] ?? en[key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  return s;
}

export function setLang(l: Lang) {
  if (!(l in DICTS) || l === lang) return;
  lang = l;
  try {
    localStorage.setItem('lang', l);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = l;
  window.laser?.setLang?.(l);
  listeners.forEach((f) => f());
}

/** Re-render the calling component when the language changes. */
export function useLang(): Lang {
  const [, bump] = useState(0);
  useEffect(() => {
    const h = () => bump((n) => n + 1);
    listeners.add(h);
    return () => {
      listeners.delete(h);
    };
  }, []);
  return lang;
}

/** Every translation of a key (used to recognise untouched default names). */
export function allTranslations(key: Key): string[] {
  return Object.values(DICTS).map((d) => (d as Record<string, string>)[key]).filter(Boolean);
}

/** Turn errors coming from the main process (error codes) into translated text. */
export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('GS_NOT_FOUND')) return t('err.gsMissing');
  if (msg.includes('FONT_INVALID')) return t('err.fontInvalid');
  if (msg.includes('JOB_RUNNING')) return t('err.jobRunning');
  if (msg.includes('STOPPING')) return t('err.stopping');
  if (msg.includes('LIBRARY_INVALID')) return t('err.libraryInvalid');
  // Strip Electron's "Error invoking remote method 'x': Error: " prefix
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

if (typeof document !== 'undefined') document.documentElement.lang = lang;
