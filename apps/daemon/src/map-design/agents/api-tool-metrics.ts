import { createHash } from 'node:crypto';
import { canonicalJson } from '../storage/canonical-json.js';

const READ_TOOLS = new Set(['map_get_context', 'map_inspect', 'map_search_layers', 'map_validate', 'read_design_reference']);
const MUTATION_TOOLS = new Set(['map_apply_transaction', 'map_update_semantics', 'map_discard_draft', 'map_commit_revision']);

type ToolMetric = { calls: number; failures: number; inputBytes: number; outputBytes: number; durationMs: number };
type ToolMeasurement = {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly output: string;
  readonly durationMs: number;
  readonly ok: boolean;
};

export class ApiToolMetrics {
  private readonly tools: Record<string, ToolMetric> = {};
  private readonly reads = new Set<string>();
  private readCalls = 0;
  private duplicateReads = 0;

  record(measurement: ToolMeasurement): void {
    const { name, input, output, durationMs, ok } = measurement;
    const serialized = canonicalJson(input);
    const metric = this.tools[name] ??= { calls: 0, failures: 0, inputBytes: 0, outputBytes: 0, durationMs: 0 };
    metric.calls++;
    metric.failures += Number(!ok);
    metric.inputBytes += Buffer.byteLength(serialized);
    metric.outputBytes += Buffer.byteLength(output);
    metric.durationMs += durationMs;
    if (READ_TOOLS.has(name)) {
      this.readCalls++;
      const signature = createHash('sha256').update(name).update(serialized).update(output).digest('hex');
      if (this.reads.has(signature)) this.duplicateReads++;
      if (this.reads.size >= 512) this.reads.delete(this.reads.values().next().value ?? '');
      this.reads.add(signature);
    }
    if (ok && MUTATION_TOOLS.has(name)) this.reads.clear();
  }

  snapshot() {
    return {
      tools: structuredClone(this.tools),
      readCalls: this.readCalls,
      duplicateReads: this.duplicateReads,
      duplicateReadRate: this.readCalls ? this.duplicateReads / this.readCalls : 0,
    };
  }
}
