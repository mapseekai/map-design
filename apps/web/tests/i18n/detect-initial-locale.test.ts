// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectInitialLocale } from '../../src/i18n';
const LS_KEY = 'map-design:locale';
const LS_SOURCE_KEY = 'map-design:locale-source';


function setStoredLocale(locale: string, source: 'manual' | 'untagged' = 'manual'): void {
  window.localStorage.setItem(LS_KEY, locale);
  if (source === 'manual') {
    window.localStorage.setItem(LS_SOURCE_KEY, 'manual');
  } else {
    window.localStorage.removeItem(LS_SOURCE_KEY);
  }
}

function setNavigatorLanguages(languages: readonly string[]): void {
  Object.defineProperty(window.navigator, 'languages', {
    configurable: true,
    get: () => languages,
  });
  Object.defineProperty(window.navigator, 'language', {
    configurable: true,
    get: () => languages[0] ?? 'en',
  });
}

function installHostWithOsLocale(value: unknown): void {
  Object.defineProperty(globalThis, '__mapDesign__', {
    configurable: true,
    value: {
      version: 1,
      client: { type: 'desktop', platform: 'test', osLocale: value },
      appearance: { setTheme: () => undefined },
      project: { pickWorkingDirectory: async () => ({ ok: false, canceled: true }) },
      shell: { openExternal: async () => ({ ok: true }) },
    },
  });
}

function clearHost(): void {
  Reflect.deleteProperty(globalThis, '__mapDesign__');
}

describe('detectInitialLocale priority chain', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearHost();
    setNavigatorLanguages(['en-US']);
  });

  afterEach(() => {
    window.localStorage.clear();
    clearHost();
  });

  it('prefers a manually-tagged localStorage pick over host and navigator', () => {
    setStoredLocale('ja', 'manual');
    installHostWithOsLocale('zh-CN');
    setNavigatorLanguages(['fr-FR']);

    expect(detectInitialLocale()).toBe('ja');
  });

  it('ignores an untagged localStorage value when a fresh host locale is available', () => {
    setStoredLocale('ja', 'untagged');
    installHostWithOsLocale('zh-CN');

    expect(detectInitialLocale()).toBe('zh-CN');
  });

  it('falls through to navigator when an unsupported locale was stored', () => {
    setStoredLocale('xx-YY', 'manual');
    setNavigatorLanguages(['de-DE']);

    expect(detectInitialLocale()).toBe('de');
  });

  it('uses the desktop host OS locale when no localStorage pick exists', () => {
    installHostWithOsLocale('zh-CN');
    setNavigatorLanguages(['en-US']);

    expect(detectInitialLocale()).toBe('zh-CN');
  });

  it('routes packaged OS locale strings through resolveSystemLocale (zh-Hant → zh-TW)', () => {
    installHostWithOsLocale('zh-Hant-TW');
    setNavigatorLanguages(['en-US']);

    expect(detectInitialLocale()).toBe('zh-TW');
  });

  it('falls back to navigator when host osLocale is missing or not a string', () => {
    installHostWithOsLocale(undefined);
    setNavigatorLanguages(['ko-KR']);
    expect(detectInitialLocale()).toBe('ko');

    installHostWithOsLocale(42);
    setNavigatorLanguages(['fr-FR']);
    expect(detectInitialLocale()).toBe('fr');
  });

  it('falls back to navigator when host osLocale is not in the supported set', () => {
    installHostWithOsLocale('nl-NL');
    setNavigatorLanguages(['pt-PT']);

    expect(detectInitialLocale()).toBe('pt-BR');
  });

  it('falls back to en when nothing else is available', () => {
    clearHost();
    setNavigatorLanguages([]);

    expect(detectInitialLocale()).toBe('en');
  });
});
