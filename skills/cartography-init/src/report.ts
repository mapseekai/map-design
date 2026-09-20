import { readFileSync } from 'node:fs';
import type {
  BindingItem,
  BindingTriage,
  DatasourceItem,
  ExtractedStyle,
  SkippedItem,
  UnresolvedItem,
} from './ir.js';
import type { Consolidated } from './consolidate.js';

const triageDecisions: Record<BindingTriage['decision'], true> = {
  prose: true,
  runtime: true,
  discard: true,
};

/**
 * INIT_REPORT.json schema:
 * {
 *   source: { kind, name, file },
 *   skipped: [{ source, layer, reason }],
 *   datasources: [{ source, layer, identity, providerType }],
 *   bindings: [{ source, layer, family, kind, expression, symbolRef, triage? }],
 *   unresolved: [{ topic, detail }],
 *   notes: string[]
 * }
 */
interface InitReport {
  source: { kind: ExtractedStyle['source']['kind']; name: string; file: string };
  skipped: SkippedItem[];
  datasources: DatasourceItem[];
  bindings: BindingItem[];
  unresolved: UnresolvedItem[];
  notes: string[];
  scaleHints: ExtractedStyle['scaleHints'];
  statistics: { elements: number; colors: number; skipped: number };
}

function buildReport(ir: ExtractedStyle, c: Consolidated, sourceFile?: string): InitReport {
  return {
    source: {
      kind: ir.source.kind,
      name: ir.source.name ?? '',
      file: sourceFile ?? ir.source.name ?? '',
    },
    skipped: ir.skipped,
    datasources: ir.datasources,
    bindings: ir.bindings.map(binding => {
      const symbolRef = c.nameMap.get(binding.layer);
      return symbolRef === undefined ? { ...binding } : { ...binding, symbolRef };
    }),
    unresolved: ir.unresolved,
    notes: c.notes,
    scaleHints: [...ir.scaleHints, ...ir.elements.flatMap(element => element.scaleHints)],
    statistics: { elements: c.elements.length, colors: Object.keys(c.tokens.colors).length, skipped: ir.skipped.length },
  };
}

/** Render the machine-readable INIT_REPORT.json payload with two-space indentation. */
export function renderReportJson(ir: ExtractedStyle, c: Consolidated, sourceFile?: string): string {
  return `${JSON.stringify(buildReport(ir, c, sourceFile), null, 2)}\n`;
}

function bulletList(items: string[]): string {
  return items.length ? items.map(item => `- ${item}`).join('\n') : '- 无';
}

/** Render the human-readable conversion report and Agent follow-up checklist. */
export function renderReportMarkdown(ir: ExtractedStyle, c: Consolidated, sourceFile?: string): string {
  const report = buildReport(ir, c, sourceFile);
  const skipped = report.skipped.map(item => `${item.source}/${item.layer}: ${item.reason}`);
  const datasources = report.datasources.map(item =>
    `${item.source}/${item.layer}: ${item.identity}${item.providerType ? ` (${item.providerType})` : ''}`,
  );
  const bindings = report.bindings.map(item =>
    `${item.source}/${item.layer} [${item.kind}]: ${item.expression} → ${item.symbolRef ?? '未匹配元素'}`,
  );
  const unresolved = report.unresolved.map(item => `${item.topic}: ${item.detail}`);
  const checklist = [
    ...report.bindings.filter(item => !item.triage?.decision)
      .map(item => `补写 binding 分诊：${item.layer}+${item.expression}`),
    ...report.unresolved.map(item => `补写未决项：${item.topic}`),
    ...report.skipped.map(item => `确认跳过项：${item.layer} (${item.reason})`),
  ];

  return [
    '# 初始化报告',
    '',
    `- 来源：${report.source.kind}${report.source.name ? ` / ${report.source.name}` : ''}`,
    `- 文件：${report.source.file}`,
    '',
    '## skipped',
    bulletList(skipped),
    '',
    '## statistics',
    `- Elements: ${report.statistics.elements}; colors: ${report.statistics.colors}; skipped: ${report.statistics.skipped}`,
    '',
    '## scaleHints',
    bulletList([...new Set(report.scaleHints.map(hint => hint.fact))]),
    '',
    '## notes',
    bulletList(report.notes),
    '',
    '## datasources',
    bulletList(datasources),
    '',
    '## bindings',
    bulletList(bindings),
    '',
    '## unresolved',
    bulletList(unresolved),
    '',
    '## 下一步：Agent 补写清单',
    bulletList(checklist),
    '',
  ].join('\n');
}

/** Return bindings that still require an explicit triage decision. */
export function checkReportTriage(jsonPath: string): { ok: boolean; pending: string[] } {
  const report = JSON.parse(readFileSync(jsonPath, 'utf8')) as Pick<InitReport, 'bindings'>;
  const pending = report.bindings
    .filter(binding => !binding.triage || triageDecisions[binding.triage.decision] !== true)
    .map(binding => `${binding.layer}+${binding.expression}`);

  return { ok: pending.length === 0, pending };
}
