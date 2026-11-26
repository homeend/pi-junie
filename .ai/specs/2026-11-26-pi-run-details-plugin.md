# @jetbrains/pi-run-details: Run details plugin for Pi

Status: approved

Type: Own plugin package

## Summary

A Pi plugin that exposes a run_details tool to report environment and session details for debugging and development, usable in plain Pi CLI and inside AIR when the bridge is present. The plugin collects Pi-side facts (cwd, skills/tools, env names with redaction, transcript if present). When running under the pi-junie bridge, it augments its result by calling the bridge’s get_run_details tool (read-only) if available, merging bridge facts (provider slots, model choice, mixes, stateDir/sessions, transcript/outputs, capabilities, detected plugins with versions, MCP servers, build info).

Goals
- One tool that works in CLI and AIR, with the same schema (schemaVersion: 1).
- Good defaults: Markdown summary by default; JSON on demand; expanded details on full.
- Safe-by-default redaction; never leaks headers, tokens, or secrets.

Non-goals
- No coupling to bridge internals or ACP shapes.
- No capture of live stderr logs (we point to transcript/outputs paths instead).

## Reuse decision

Requirements (R1–R15): see Bridge spec for the full list; the plugin covers the Pi-only subset (cwd, skills/tools, agentDir, env names with redaction, transcript presence) and augments with bridge facts via a stable tool when available.

Candidates: none suitable; this is not provided by a known plugin. No existing plugin found.

Options considered: build nothing (insufficient for CLI), own plugin (chosen). The bridge exposes its details via a read-only tool to keep concerns separate.

Chosen option: Our own plugin (packages/run-details), modeled as a thin collector. No code is copied from elsewhere.

Compatibility: When both the plugin and bridge are present, the plugin calls the bridge tool; otherwise it returns Pi facts only. No direct imports from the bridge.

## Design

Package name: @jetbrains/pi-run-details
Location: packages/run-details
Exports: a Pi extension that registers a run_details tool

Tool ID: run_details
- Input schema (identical in CLI and AIR): { json?: boolean, full?: boolean }
- Invocation: standard tool exposure (callable by LLM and skills); the plugin internally calls ctx.executeTool('get_run_details', { full }, { signal }) when present, forwarding the abort signal.
- Result contract (SDK-shaped):
  - Registration: the tool declares outputSchema = RUN_DETAILS_SCHEMA (a JSON Schema with $id 'jetbrains/run-details.v1').
  - Success: outcome.result.structuredContent contains the JSON object defined below (validated against outputSchema). outcome.result.content contains model-visible text: Markdown summary by default; serialized JSON text when input.json===true.
  - Error: isError=true; code in outcome.result.details.code ('uncallable'|'malformed'|'error'|'cancelled'|'incompatible_version'); message optional. The plugin does not throw.
  - Versioning: the consumer (plugin) validates structuredContent.schemaVersion===1; an incompatible version sets bridgeError.code='incompatible_version'.
- Behavior:
  1) Collect Pi facts from authoritative sources:
     - cwd: ExtensionContext.cwd (string property)
     - agentDir: SDK default agent dir (process-level); labeled as processDefaultAgentDir to avoid misrepresenting bridge-specific dirs.
     - tools: registered tool names from ExtensionAPI.getAllTools() (not just callable); a separate field can list callable tools if needed in v2
     - skills: from session inputs known to be skills or from configured skill roots (best-effort); labeled with path when available
     - env: names only for PI_* and JUNIE_*; apply sensitive-name filter (case-insensitive KEY|TOKEN|SECRET) and omit matches; never inspect or include values in v1
     - transcript: presence flag and path if provided by SessionManager; path may not exist yet
  2) Bridge augmentation contract:
     - Tool name: get_run_details
     - Input: { full?: boolean }
     - Exposure: callable (not hidden); not advertised to the model in prompts
     - Call via ctx.executeTool('get_run_details', { full }, { signal })
     - On success: validate result.schemaVersion === 1 and that result.session exists; attach under top-level key bridge
     - On absent/uncallable/malformed/error/cancelled: do not throw; return pi-only results and include bridgeError: { code: 'absent'|'uncallable'|'malformed'|'error'|'cancelled', message?: string }
  3) Output selection for callers:
     - structuredContent always carries the JSON object.
     - content (model-visible text): Markdown summary by default; serialized JSON text when input.json===true.
     - The json flag only changes content rendering; structuredContent is unchanged.
     - The full flag is forwarded to the bridge call. In plain Pi v1, full makes no change (no Pi-only expansion in v1).

JSON schema (schemaVersion: 1)
- schemaVersion: 1
- pi: { status: 'initialized' | 'not-initialized', cwd: string, processDefaultAgentDir?: string, skills?: [{name, path?: string}], tools?: string[], env: { names: string[] }, transcript?: { path?: string, exists?: boolean } }. Before initialization omit skills/tools; an empty array means known-empty, never unknown.
- bridge?: object copied from the bridge tool when present (see Bridge spec for fields, including logging and storage.outputsDir)
- bridgeError?: { code: 'absent'|'uncallable'|'malformed'|'error'|'cancelled'|'incompatible_version', message?: string }

Security and redaction
- Never include provider headers or auth material.
- Environment: include only env NAMES (PI_*, JUNIE_*). Case-insensitive sensitive-name filter (KEY|TOKEN|SECRET) applied to names; matching entries are omitted. Values are never inspected or serialized in v1.

CLI and AIR
- Works identically in plain Pi. In AIR, the plugin augments via the bridge tool if available.

## Tasks (test-first, gated)
- P0: Pin contracts shared with the bridge: input {full?}, outputSchema 'jetbrains/run-details.v1', structuredContent with schemaVersion:1, error codes and mapping. Add a contract test stub.
- T1: Create package scaffold packages/run-details (package.json with pi extensions, tsconfig, README, basic tests).
- T2: Write failing unit tests for piCollector + redaction utilities; implement until green.
- T3: Implement run_details tool returning structuredContent with schemaVersion:1 and outputSchema, and the internal bridge-call contract; add a local convenience skill (repo-only) to render Markdown from JSON.
- T4: Detect and call get_run_details via ctx.executeTool; handle absent/uncallable/error/malformed/cancelled/incompatible_version per contract; unit tests.
- T5: README: usage in plain Pi and under AIR; document sensitive-name filter and omission semantics.
- T6: Integration tests using a controlled fake provider for get_run_details and a standalone Pi session with no host provider. Neither requires changes to the bridge. Test text and structured results at the real SDK boundary.
- T7: Export UI-independent collection/composition/schema/redaction/rendering via @jetbrains/pi-run-details/core. Add repo-local /skill:run-details and development CLI loading with a documented disable switch; no global installation or native CLI /run-details promised. Bridge loading and real-provider augmentation belong exclusively to the dependent bridge spec.

## Acceptance checks
- A1: In plain Pi, calling run_details returns structuredContent with schemaVersion:1 validated against the registered outputSchema (RUN_DETAILS_SCHEMA with $id 'jetbrains/run-details.v1'); pi fields populated; env names filtered deterministically. content shows Markdown by default and JSON when json:true.
- A2: Under the bridge, run_details returns a superset including bridge fields when available; provider headers are never present; version mismatch and other errors map to bridgeError and do not throw.
- A3: A denied or unavailable full request yields a normal (non-full) bridge result with bridge.fullApproved === false (see bridge spec), and/or a bridgeError with code; the call does not fail the tool.
- A4: Redaction: any env name matching KEY|TOKEN|SECRET (case-insensitive) is omitted; values are never inspected or serialized.
- A5: Integration: (a) contract test with a fake get_run_details provider passes; (b) standalone Pi with no provider returns Pi-only data and model-visible content. Real bridge loading/augmentation is verified exclusively under the dependent bridge spec.

## Confirmed delivery and common library (post-audit revision)

The user confirmed CLI delivery as `run_details` plus repository-local `/skill:run-details`; AIR's native command belongs to the dependent bridge spec. The tool and skill are adapters over common collection/composition/rendering, not separate implementations. Export that pure library from this package (`@jetbrains/pi-run-details/core`); a separate npm core package is not required. Importing the library must not register the extension. Common top-level report/schema `$id` is `jetbrains/run-details.v1`; host-only schema `$id` is `jetbrains/run-details-host.v1`. Validate the latter before composition. The bridge command consumes this same pipeline, so command and plugin reports have the same normalized shape.

Pi-only facts must include process/session cwd distinctions, current model/effort, Pi/plugin/Node versions, detected versus actually loaded plugins where observable, and logging destinations/status from supported SDK/loaded logger metadata. Default includes transcript/output/logger paths when known. Do not invent a CLI process log, claim a configured path exists without checking, or imply plain Pi has ACP wire logging. Report absent/unsupported destinations explicitly. Never capture log contents. Full adds PID/context window only through an authorized disclosure path; standalone Pi v1 may leave these expanded fields unavailable rather than prompt headless or leak them. Environment names remain filtered; never serialize values. Tests must cover these core requirements in CLI, not just bridge augmentation.

The shared collector takes a plain `PiFactsSnapshot`, not a live SDK context: `{ status, cwd, processCwd, processDefaultAgentDir?, skills?, tools?, transcript?, model?, plugins?, logging?, build }`. Collection receives the filtered environment names separately; snapshot fields are allowlisted and safely projected, not blindly serialized. The plugin tool adapter fills it from ctx/pi/SessionManager. The bridge command adapter fills it from existing bridge/session/process state: before Pi initialization use status='not-initialized' and omit unavailable skills/tools/model/loaded-plugin fields; after initialization use existing this.pi and captured getAllTools/loader snapshots. Both call the same pure collector/composer/renderer, with no second collector or forced initialization. Parity is required only for an initialized same-session snapshot. Add pre-init schema/render tests and prove no Pi creation. This contract correction after the bridge's third audit is also unaudited.

The dependent bridge spec defines exact host field semantics, logging provenance and disclosure fields; it does not change standalone plugin delivery gates. Plugin must ship with fake-provider and standalone-no-provider tests before bridge implementation.

Surfaces: plain Pi interactive (tool plus local skill), headless (tool text/structured content without UI), AIR (same plugin via later adapter). Existing Pi transcript is the only persistence; no diagnostic store. Source of behaviour: own plugin plus SDK facts, optional host provider. Layers touched: no bridge layers in this spec. First failing test: `packages/run-details/test/run-details.test.ts`. Hand check: `scripts/dev.sh cli-test`, invoke tool/skill; confirm cwd/log/build/plugin details without AIR. AIR augmentation hand checks belong to the bridge spec. Update plugin README, root README and actual feature-map diagnostics row. Before completion run `npm run check`, `npm test` and required reviews. No open user questions.

Review status: three audits exhausted, latest verdict CHANGES. This delivery/common-library revision is **not audited**; do not describe the spec as approved.

## Risks
- Divergence between plugin JSON and bridge JSON: mitigated with a top-level schemaVersion and additive fields only.

## Docs
- packages/run-details/README.md: what it does; how to load (`pi -e ./packages/run-details`).
- Mention in docs/architecture.html package list if relevant.
