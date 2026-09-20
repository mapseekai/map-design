import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseLyrx, parseStylx } from './adapters/arcgis.js';
import { parseQgis } from './adapters/qgis.js';
import { parseSld } from './adapters/sld.js';
import { parseStyleJson } from './adapters/style-json.js';
import { detectSource } from './detect.js';
import { initializeDocument, VerificationError } from './init.js';
import type { ExtractedStyle, SourceKind } from './ir.js';
import { checkReportTriage } from './report.js';

const usage = `用法:\n  init --input <path> --output <CARTOGRAPHY.md> [--name <name>] [--report <md>] [--report-json <json>]\n  init --check-report <INIT_REPORT.json>`;

interface InitArgs {
  input: string;
  output: string;
  name?: string;
  report?: string;
  reportJson?: string;
}

function parseArgs(argv: string[]): InitArgs | { checkReport: string } {
  const values: Record<string, string | undefined> = {};
  const supported: Record<string, true> = {
    '--input': true,
    '--output': true,
    '--name': true,
    '--report': true,
    '--report-json': true,
    '--check-report': true,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !supported[flag] || !value || value.startsWith('--') || values[flag]) {
      throw new Error(usage);
    }
    values[flag] = value;
  }
  const checkReport = values['--check-report'];
  if (checkReport) {
    if (Object.keys(values).length !== 1) throw new Error(usage);
    return { checkReport };
  }
  const input = values['--input'];
  const output = values['--output'];
  if (!input || !output) throw new Error(usage);
  const options: InitArgs = { input, output };
  if (values['--name']) options.name = values['--name'];
  if (values['--report']) options.report = values['--report'];
  if (values['--report-json']) options.reportJson = values['--report-json'];
  return options;
}

function parseInput(kind: SourceKind, input: Buffer, fileName: string): ExtractedStyle {
  switch (kind) {
    case 'style': return parseStyleJson(input.toString('utf8'), fileName);
    case 'qgis': return parseQgis(input, fileName);
    case 'lyrx': return parseLyrx(input, fileName);
    case 'stylx': return parseStylx(input, fileName);
    case 'sld': return parseSld(input.toString('utf8'), fileName);
  }
}

/** Execute the init CLI without terminating the process, for embedding and tests. */
export async function runCli(argv: string[]): Promise<number> {
  let parsed: InitArgs | { checkReport: string };
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : usage);
    return 2;
  }

  if ('checkReport' in parsed) {
    try {
      const triage = checkReportTriage(parsed.checkReport);
      if (!triage.ok) console.log(`待分诊 bindings:\n${triage.pending.join('\n')}`);
      return triage.ok ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  try {
    const input = readFileSync(parsed.input);
    const fileName = basename(parsed.input);
    const ir = parseInput(detectSource(parsed.input, input), input, fileName);
    const result = initializeDocument(
      ir,
      parsed.name ? { name: parsed.name, sourceFile: fileName } : { sourceFile: fileName },
    );

    writeFileSync(parsed.output, result.document);
    if (parsed.report) writeFileSync(parsed.report, result.reportMarkdown);
    if (parsed.reportJson) writeFileSync(parsed.reportJson, result.reportJson);
    console.log(`已生成 ${parsed.output}（${result.consolidated.elements.length} 个元素）。`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof VerificationError ? 1 : 2;
  }
}
