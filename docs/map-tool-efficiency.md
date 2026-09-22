# Map tool efficiency

Implemented against the existing batch-read work in the current checkout.

## Behavior

- `map_search_layers` can return selected paint/layout properties directly. `map_inspect` uses the same projection. Omitted properties and continuation offsets are explicit.
- Reads default to 16 KiB, with an explicit 8–256 KiB budget. Large expressions remain accessible by requesting a larger budget; the hard maximum is not the default.
- `setLayersProperties` sends one shared property object for multiple explicit IDs. The daemon expands it atomically, preserves original-request idempotency, emits standard SDK operations, and enforces the existing 100-expanded-operation limit.
- Native validation returns up to 20 safe actionable findings, bounded to 16 KiB. Displayed and omitted counts agree. Writes return changed IDs, warnings and validation status without echoing full diffs.
- Runs reuse their initial canonical context and successful current write validation. The bundled workflow no longer mandates redundant context/validation calls. The full selected CARTOGRAPHY document remains separately injected.
- Native read preflight shares the query snapshot. A context read now loads three blobs once instead of loading them twice in the query/validation services plus a separate native style load.
- Concurrent snapshot reads coalesce. Pure validation results are cached by project and complete canonical inputs, with 64-entry/4 MiB bounds. Draft, explicit validation, preview and revision evidence paths share this computation.
- The API adapter compacts old large successful inspect/search results, preserves recent results, tool arguments, errors and preview/write evidence, and marks compacted details as requiring a fresh read.
- An already injected bundled skill is not returned again in full. Explicit cartography tasks omit native map tools; normal map tasks retain the supplied authorized tool set.
- API diagnostics now report per-tool input/output bytes, duration, failures, duplicate read rate, schema bytes and compaction totals. Write summaries distinguish requested operations from expanded SDK operations.
- Native and MCP descriptions share one source. The reference document omits duplicate JSON schemas already advertised by tools.

## Consistency choices

Settled disk snapshots are not cached across separate requests: blob integrity, existence, lifecycle and current revision are still checked. Only concurrent loads and deterministic validation computation are reused. Revision commit still verifies current, unexpired preview evidence and storage integrity.

History compaction is implemented in the daemon-owned API adapter. External coding-agent runtimes retain responsibility for their own conversation history. No speculative stage-based tool removal or concurrent writes were introduced.

Payload byte savings are not equivalent to billed model-token savings. Real provider usage remains available through the existing input/output token counters; compare equal tasks and success rates before claiming a percentage.

## Verification

Runtime: isolated Node v24.21.0, downloaded from nodejs.org and SHA-256 verified. The default machine shell still resolves Node 22; project checks used the isolated runtime explicitly.

- Map-domain contract build and full suite: 101 passed.
- Daemon build and source/test TypeScript checks: passed.
- LSP diagnostics: no errors in map contracts, native tool modules, API adapter and the changed application services (the initial whole-directory request timed out; focused checks passed).
- Initial integrated daemon regression run: 250 passed, one Windows process-tree cancellation expectation failed. Follow-up isolated synthetic fixture PIDs from host process control and added normal Windows shutdown coverage. The complete run-service suite now passes 65 tests; daemon test typechecking and LSP diagnostics pass. Production cancellation code was unchanged. A real owned Windows parent/descendant check returned `parentExited: true, descendantExited: true`.
- Final native/result/operation-summary check: 38 passed, including actual native calls backed by isolated SQLite and blob storage.
- Final diagnostic count projection check: three passed; a final daemon build also passed.
- `git diff --check`: passed.
- Repository guard follow-up: all checks now pass. The packaged Electron bootstrap is a test-owned TypeScript fixture bundled only into an isolated temporary directory. CI runs the retained protocol scenario under Xvfb, and scope/guard checks enforce that coverage. CRLF workflow text and deleted-but-unstaged JavaScript paths no longer cause false failures.
- Follow-up validation: seven guard regressions, three resource-contract tests and the real Electron protocol scenario pass. E2E/scripts/packaged test typechecks and actionlint 1.7.12 pass (optional ShellCheck/Pyflakes integrations were unavailable locally). The obsolete resource prose test now checks declared tool names and validates JSON examples against actual input schemas.
- Windows fake-runtime follow-up: reproduced all 15 startup failures, then reused the platform command wrapper for `.cmd` launches and invoked the CLI tripwire by its full path to avoid the Windows `md` builtin. Tests now wait for process closure and cover paths containing spaces. All 16 fixture tests and the full E2E Vitest suite (36 tests across five files) pass, as do E2E typechecking, changed-file LSP diagnostics and `pnpm guard`.
- Independent Windows launch QA started all five fake agent executables, completed the Codex app-server initialization handshake, observed clean process closure, and verified the CLI tripwire capture and exit code 97 from a path containing spaces. Temporary QA state was removed. This follow-up exercised fixture processes; it did not rerun the browser UI suite or other operating systems.

Manual protocol evidence is recorded separately in `map-tool-efficiency-qa.json`. A standalone Node command drove projected search, a three-layer compact edit, preview fulfillment, commit, replay and stale-revision rejection through actual daemon services and isolated storage. All five scenarios and the stale-revision case passed. Preview fulfillment used an explicitly synthetic PNG/report; this is protocol evidence, not visual cartographic approval.

On that small fixture, the shared transaction payload fell from 283 to 145 bytes (48.8%); the selected paint property from 39 to 24 bytes (38.5%). Validation recorded four cache hits and two misses; commit replay retained exactly one revision. These are fixture payload measurements, not a live model-token benchmark.
