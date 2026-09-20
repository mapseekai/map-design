import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { resolveSystemLocale } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';
import { LOCALES, LOCALE_LABEL, type Dict, type Locale } from '../../src/i18n/types';

const EXPECTED_LOCALES = ['en', 'id', 'de', 'zh-CN', 'zh-TW', 'pt-BR', 'es-ES', 'ru', 'fa', 'ar', 'ja', 'ko', 'pl', 'hu', 'fr', 'uk', 'tr', 'th', 'it'];
const RETAINED_NAMESPACES = ['common.', 'mapDesign.', 'chat.', 'settings.', 'agents.', 'errors.', 'questionForm.', 'todos.'] as const;
const SOURCE_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../../src');
const ACTIVITY_KEYS = [
  'mapDesign.activity.working', 'mapDesign.activity.completed',
  'mapDesign.activity.failed', 'mapDesign.activity.canceled',
  'mapDesign.activity.stepCountOne', 'mapDesign.activity.stepCountMany',
  'mapDesign.activity.expand', 'mapDesign.activity.collapse',
  'mapDesign.activity.statusFallback', 'mapDesign.activity.summaryFallback',
  'mapDesign.activity.toolsOmitted',
  'mapDesign.activity.stagePreparing', 'mapDesign.activity.stageAnalyzing',
  'mapDesign.activity.stageValidating', 'mapDesign.activity.stagePreviewing',
  'mapDesign.activity.stageCommitting', 'mapDesign.activity.thinking',
  'mapDesign.activity.requestSummary', 'mapDesign.activity.resultSummary',
  'mapDesign.activity.toolGetContext', 'mapDesign.activity.toolInspect',
  'mapDesign.activity.toolSearchLayers', 'mapDesign.activity.toolApplyTransaction',
  'mapDesign.activity.toolUpdateSemantics', 'mapDesign.activity.toolValidate',
  'mapDesign.activity.toolRenderPreview', 'mapDesign.activity.toolCommitRevision',
  'mapDesign.activity.toolDiscardDraft', 'mapDesign.activity.toolGeneric',
  'mapDesign.activity.toolsOmittedCount', 'mapDesign.activity.toolsOmittedFailures',
  'mapDesign.composer.runActions',
] as const;

function placeholders(value: string): string[] {
  return Array.from(value.matchAll(/\{(\w+)\}/g), (match) => match[1] ?? '').sort();
}

async function loadDict(locale: Locale): Promise<Dict> {
  const module = await import(`../../src/i18n/locales/${locale}.ts`);
  const dict = Object.values(module).find((value): value is Dict => Boolean(value) && typeof value === 'object');
  if (!dict) throw new Error(`No dictionary export found for locale ${locale}`);
  return dict;
}

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = [base, ...['.ts', '.tsx'].map((extension) => `${base}${extension}`), resolve(base, 'index.ts'), resolve(base, 'index.tsx')];
  return candidates.find((candidate) => existsSync(candidate) && extname(candidate) !== '') ?? null;
}

function retainedSourceKeys(): string[] {
  const pending = [resolve(SOURCE_ROOT, 'App.tsx')];
  const seen = new Set<string>();
  const keys = new Set<string>();
  while (pending.length) {
    const path = pending.pop();
    if (!path || seen.has(path) || path.includes('/i18n/')) continue;
    seen.add(path);
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const imported = resolveImport(path, node.moduleSpecifier.text);
        if (imported) pending.push(imported);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['t', 'uiT'].includes(node.expression.text)) {
        const argument = node.arguments[0];
        const collectStringLiterals = (candidate: ts.Node): void => {
          if (ts.isStringLiteral(candidate) && candidate.text.includes('.')) keys.add(candidate.text);
          ts.forEachChild(candidate, collectStringLiterals);
        };
        if (argument) collectStringLiterals(argument);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...new Set([...keys, ...ACTIVITY_KEYS])].sort();
}

describe('i18n locales', () => {
  it('resolves the initial locale from browser language preferences', () => {
    expect(resolveSystemLocale(['zh-Hans-CN', 'en-US'])).toBe('zh-CN');
    expect(resolveSystemLocale(['zh-Hant-HK', 'en-US'])).toBe('zh-TW');
    expect(resolveSystemLocale(['pt-PT', 'en-US'])).toBe('pt-BR');
    expect(resolveSystemLocale(['es-MX', 'en-US'])).toBe('es-ES');
    expect(resolveSystemLocale(['nl-NL', 'en-US'])).toBe('en');
    expect(resolveSystemLocale(['nl-NL'])).toBeNull();
  });

  it('registers every supported locale in the language menu', () => {
    expect(LOCALES).toEqual(EXPECTED_LOCALES);
    expect((LOCALE_LABEL as Record<string, string>).id).toBe('Bahasa Indonesia');
    expect((LOCALE_LABEL as Record<string, string>).de).toBe('Deutsch');
    expect((LOCALE_LABEL as Record<string, string>).it).toBe('Italiano');
    expect((LOCALE_LABEL as Record<string, string>).ja).toBe('日本語');
  });

  it('preserves the MapDesign product name in Chinese workbench titles', async () => {
    const translatedProductNames = {
      'zh-CN': '地图设计',
      'zh-TW': '地圖設計',
    } as const;

    for (const locale of ['zh-CN', 'zh-TW'] as const) {
      const title = (await loadDict(locale))['mapDesign.home.title'];
      expect(title, locale).toBe('MapDesign 工作台');
      expect(title, locale).toContain('MapDesign');
      expect(title, locale).not.toContain(translatedProductNames[locale]);
    }
  });

  it('defines every activity and composer action label in each locale', async () => {
    for (const locale of LOCALES) {
      const dict = await loadDict(locale);
      for (const key of ACTIVITY_KEYS) {
        expect((dict as unknown as Record<string, string>)[key], `${locale}.${key}`).toBeTruthy();
      }
    }
  });

  it('implements the exact retained dictionary in every locale', async () => {
    const englishKeys = Object.keys(en).sort();
    const sourceKeys = retainedSourceKeys();
    expect(englishKeys).toEqual(sourceKeys);
    expect(englishKeys.every((key) => RETAINED_NAMESPACES.some((namespace) => key.startsWith(namespace)))).toBe(true);

    for (const locale of LOCALES) {
      const dict = await loadDict(locale);
      expect(Object.keys(dict).sort(), locale).toEqual(englishKeys);
      for (const key of englishKeys as Array<keyof Dict>) {
        expect(placeholders(dict[key]), `${locale}.${key}`).toEqual(placeholders(en[key]));
      }
    }
  });
});
