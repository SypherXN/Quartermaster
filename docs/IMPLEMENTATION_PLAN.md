# Quartermaster implementation plan

> Source of truth for `/implement-by-id #N` or `/implement-by-id <id>`. Keep task statuses synchronized with `plans/quartermaster.plan.md`; never rename or renumber tasks.

## Goal and constraints

Build and verify the native OpenCode V2 **server plugin** and project-scoped RPC. The opt-in local report gateway (#16) is completed. Live project config writes (#33) are completed. The host-mediated OpenChamber bridge (#36) is implemented and smoke-tested. Offline report import and JSON draft export are delivered fallbacks, not substitutes for the requested live interaction. Quartermaster assigns new agents via ordered plans without changing active turns. Telemetry, unknown-aware budgets, errors and configured-rate estimates must remain evidence-based; unknown attribution stays unknown.

**Boundaries:** Never change an in-flight turn or silently override a user-selected model. Cost is an estimate from configured provider/model rates, not a provider bill or price-based routing heuristic; label currency, rates and unknown amounts. Token budgets remain user-set limits/alerts. Unknown/stale usage is not confirmed exhaustion. Do not poll provider APIs independently. Slim currently disables V2 automatic foreground fallback because `switchModel` is not atomic per turn; host-native retries stay intact. Agent assignment is distinct from mid-turn failover. Account quota percentages from opencode-usage are not measured session tokens. Count host-reported tokens once; label missing/unattributed usage explicitly; never infer exact tokens from direct calls without a trusted report. Store no prompts, credentials or permission-request contents in telemetry. The local `opencode-usage.json` is live account state and must remain gitignored; tests use synthetic fixtures.

**Sources:** [V2 plugins](https://opencode.ai/v2/docs/build/plugins/), [V2 RPC](https://opencode.ai/v2/docs/build/plugins/rpc/), [agents](https://opencode.ai/v2/docs/agents/), [opencode-usage `USAGE_RPC`](https://github.com/SypherXN/opencode-usage/blob/master/src/rpc.ts), [Slim's V2 fallback limitation](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/docs/configuration.md). Recheck signatures before coding. Usage exposes cached `status({})` with `availability`, `stale`, `nextAvailableAt`, windows and reset estimates. Map usage source IDs explicitly to OpenCode provider IDs. Go paid models share a quota; free models may be exempt. `models.go` estimates are not per-model hard quotas.

**Verified upstream contract (opencode-usage master, 2026-09-27):** The complete private npm package source is in [SypherXN/opencode-usage](https://github.com/SypherXN/opencode-usage): `index.ts` loads the V2 plugin, `src/rpc.ts` exports `USAGE_RPC` (`id: "opencode-usage"`, one `status` method with strict `{ refresh?: boolean }` input), `src/status.ts` owns polling, and `src/types.ts` defines `schemaVersion: 1`. `package.json` exports `opencode-usage/rpc` and requires Node >=23.6. Plugin clients call `await ctx.rpc(USAGE_RPC).status({})`. **This is read-through**, not a guaranteed zero-poll read: when its cache is due, the usage plugin itself can coalesce an upstream poll; `refresh: true` requests a rate-limited immediate all-source refresh. Quartermaster must not add another provider poller or call `refresh: true` per assignment. The usage plugin also publishes an atomic JSON status file (`filePath` option -> `GO_MODEL_USAGE_FILE` -> project `opencode-usage.json`); prefer RPC, with file input only as a deliberately configured fallback. Its source IDs are `go`, `codex`, `cursor`; Go's host provider ID is `opencode-go`, not `go`. Stale (>5 min), auth and network errors give `unknown`; `nextAvailableAt` is the **latest** reset of concurrently limited windows when inferable. The usage plugin handles provider-reported reset gating and 15-minute no-reset backoff itself; Quartermaster should cache decisions, not duplicate those polling rules.

**Telemetry evidence:** The [V2 API](https://opencode.ai/v2/docs/api) describes assistant messages with a model reference and optional token counts (input/output/reasoning/cache read/write); session info includes project ID, parent session and location. Verify which completion/update event and revision carries authoritative usage before ingesting; messages can stream, retry and lack token counts. A session total is not an additional billable event. Preserve token categories instead of summing potentially overlapping provider fields blindly.

**Integration boundary:** Quartermaster owns the server RPC in [PLUGIN_INTEGRATION.md](PLUGIN_INTEGRATION.md). #16's separate opt-in loopback gateway is completed: it keeps credentials server-side, checks the configured directory's project, and shows plans, availability, and the report. It fixes location at startup and does not follow active-project switches. #33's opt-in gateway apply writes one project Quartermaster options object and the next assignment reads that file. #19 records the earlier published-SDK limitation; #36 now provides a host-mediated active-project bridge in the maintainer-authorized OpenChamber checkout. #28/#29 completion evidence is recorded with each task. No browser-held credentials, broad proxy, implicit listener or shadow host config. See [bridge evidence](OPENCHAMBER_BRIDGE.md) and [local-tool limits](../web/README.md).

**Permission-reviewer boundary (historical):** [warc0s/opencode-permission-reviewer](https://github.com/warc0s/opencode-permission-reviewer) supports V2 and uses isolated, tool-free reviewer sessions (or a direct Jev backend). Its model comes from trusted global configuration. The completed #26 records the earlier opt-in bridge; further reviewer adapter work is deferred. Quartermaster cannot claim reviewer token attribution without trusted host-owned session/request linkage; direct Jev usage remains unknown without authoritative counts.

**OpenChamber bridge finding:** #19 found no documented active-server endpoint or authentication handoff in the then-published extension SDK. Task #36 added and smoke-tested a versioned, host-mediated `quartermaster` capability in the authorized OpenChamber checkout. See [the evidence and threat model](OPENCHAMBER_BRIDGE.md).

**Quartermaster options** are nested in the V2 `plugins[].options` object; they are not custom top-level `opencode.json(c)` fields. OpenCode preserves other config fields, while Quartermaster validates only its own options object:

```jsonc
{
  "plans": { "review": ["provider-a/quality-model", { "id": "provider-b/backup-model", "variant": "fast" }] },
  "agents": { "quartermaster-test": "review", "reviewer": "review" },
  "workTypes": { "review": "review" },
  "usageSources": { "provider-a": "codex", "provider-b": "go" },
  "quotaExemptModels": ["provider-b/free-model"],
  "providerCooldownMs": 300000,
  "localHealthTimeoutMs": 2000,
  "localEndpoints": { "ollama": "http://127.0.0.1:11434" }
}
```

Candidate strings use `providerID/modelID`; object candidates add an optional `variant`. Provider model IDs may themselves contain `/`. Agent and work-type bindings must name configured plans. Plans require at least one unique candidate. `usageSources` maps OpenCode provider IDs to `go`, `codex`, or `cursor`; `quotaExemptModels` lists explicit fully qualified models exempt from those quotas. Missing bindings leave the original host/Slim choice alone; an unknown caller-supplied work-type alias falls back to the agent binding with an explanation, or returns `no-plan` if the agent is unbound. Work types are never inferred from prompt text. `providerCooldownMs` defaults to 300000 ms and `localHealthTimeoutMs` to 2000 ms; local endpoint URLs are restricted to loopback HTTP(S), probed with bodyless credential-free GETs, and cached for five seconds. **Precedence:** explicit user model > eligible pin > explicit caller work type > agent binding > original host/Slim model. A pin changes priority, never bypasses exhaustion or offline checks. For a configured plan with no eligible entries, return `no eligible model` with reasons; integrations explicitly choose error vs host fallback. Reload agents only at supported boundaries.

## Evidence path

Use deterministic selector tests with injected clock and synthetic usage, failure and health inputs. Verify native assignment with two accessible models: new assignment A (primary), block primary and run B (backup), restore and run C (primary). Test explicit override, unbound agent, exported RPC and missing-service fallback in Quartermaster tests. Compare supported project rollups to deduplicated records while labeling unknown provider/model/plugin dimensions. Simulate concurrent budgets and reset windows without exhausting real quotas. Distinguish synthetic from live-host proof; UI-specific tests are required for the planned Quartermaster and OpenChamber interfaces, but unrelated consumer adapters are not prerequisites.

## Task index

| # | id | status | phase | what implementing does |
|---|---|---|---|---|
| 1 | `project-scaffold` | completed | foundation | V2 plugin package and checks |
| 2 | `plan-config` | completed | foundation | Validate plans, bindings and precedence |
| 3 | `model-selector` | completed | foundation | Pure selector and reasons |
| 4 | `native-agent-routing` | completed | standalone | Native V2 assignment |
| 5 | `test-agent` | completed | standalone | Dynamic test agent and smoke proof |
| 6 | `usage-rpc-client` | completed | availability | Consume cached usage RPC |
| 7 | `quota-eligibility` | completed | availability | Map quota to models and exemptions |
| 8 | `work-type-routing` | completed | availability | Explicit work-type selection |
| 9 | `provider-cooldown` | completed | availability | Scoped failures and recovery |
| 10 | `local-health` | completed | availability | Bounded local endpoint checks |
| 11 | `availability-refresh` | completed | availability | Refresh/reset state lifecycle |
| 12 | `pins-and-reasons` | completed | control | Pin/unpin and explanations |
| 13 | `quartermaster-rpc` | completed | control | Cross-plugin selection API |
| 14 | `slim-agent-bridge` | cancelled | external | Deferred Slim adapter |
| 15 | `slim-integration-tests` | cancelled | external | Deferred Slim integration proof |
| 16 | `gui-readonly` | completed | web UI | Opt-in loopback report, plans, and availability view with project check |
| 17 | `gui-editor` | completed | web UI | Assignment editor for plans, models, variants, and bindings |
| 18 | `atomic-fallback-gate` | cancelled | external | Deferred host mid-turn capability |
| 19 | `openchamber-rpc-bridge` | completed | UI foundation | Document unsupported panel-to-server RPC; retire TUI experiment |
| 20 | `token-telemetry-contract` | completed | telemetry | Confirm authoritative token/event/project semantics |
| 21 | `token-ledger` | completed | telemetry | Ingest and persist deduplicated token records |
| 22 | `token-attribution` | completed | telemetry | Opt-in self-reported plugin usage attribution |
| 23 | `token-budget-config` | completed | allocation | Unknown-aware Quartermaster budget configuration |
| 24 | `token-budget-gate` | completed | allocation | Advisory Quartermaster assignment warnings |
| 25 | `token-reporting-rpc` | completed | control | Versioned bounded Quartermaster reporting API |
| 26 | `reviewer-model-bridge` | completed | integration | Opt-in permission-reviewer model selection |
| 27 | `reviewer-token-link` | cancelled | external | Deferred reviewer-owned attribution |
| 28 | `gui-token-usage` | completed | OpenChamber | Authorized OpenChamber usage and partial-estimate view |
| 29 | `gui-token-budgets` | completed | OpenChamber | Authorized OpenChamber plan and budget editor |
| 30 | `token-integration-tests` | completed | verification | Quartermaster-only synthetic and host evidence |
| 31 | `provider-error-telemetry` | completed | telemetry | Timestamped provider/model error and rate-limit history |
| 32 | `plugin-interface-contract` | completed | control | Verify exported cross-plugin contract in Quartermaster |
| 33 | `plan-config-rpc` | completed | control | Opt-in project options apply; later assignments read the saved file |
| 34 | `session-plan-attribution` | completed | telemetry | Evidence-backed session/agent/plan dimensions or unknown |
| 35 | `token-cost-estimates` | completed | telemetry | Partial estimates from configured, labeled token rates |
| 36 | `openchamber-project-bridge` | completed | integration | Implement and smoke-test the authenticated active-project bridge |

## Tasks

### [#1] [project-scaffold] Native plugin package

**Num:** 1

**Status:** completed

**Priority:** critical

**Scope:** Small TypeScript package with current V2 `Plugin.define` entrypoint, installation docs, typecheck/test/build scripts, plugin load smoke test. No routing yet.
**Acceptance criteria:**
- [x] Clean checkout installs and runs documented checks non-interactively.
- [x] V2 loads/disposes plugin without changing any agent model.
- [x] Generated artifacts and private live status remain untracked; no secrets in fixtures.
**Likely files:** `package.json`, `src/index.ts`, `tsconfig.json`, `README.md`, `test/`.
**Depends on:** none.

### [#2] [plan-config] Named plans and binding config

**Num:** 2

**Status:** completed

**Priority:** critical

**Scope:** Choose supported V2 config location/API; normalize ordered model refs/variants, plan/agent/work-type bindings, source mapping, cooldown and local endpoint settings. Reject empty/duplicate plans, unknown bindings, malformed refs, invalid durations; preserve unrelated settings.
**Acceptance criteria:**
- [x] Valid sample parses; invalid values give actionable field paths.
- [x] Document override/pin/work-type/agent/host precedence and absent binding behavior.
- [x] Tests cover malformed refs, missing plans, variant and defaults.
**Likely files:** `src/config.ts`, `test/config.test.ts`, `examples/quartermaster.json`.
**Depends on:** #1.

### [#3] [model-selector] Pure ordered selector

**Num:** 3

**Status:** completed

**Priority:** critical

**Scope:** Pure function takes normalized plan, registry and injected eligibility snapshot; returns chosen ref with structured selected/skipped reasons or explicit no-plan/no-eligible result. Unknown/stale never masquerades as `limited`.
**Acceptance criteria:**
- [x] First eligible wins, variant survives, skipped entries have stable reasons.
- [x] Recovered primary wins next selection; no eligible is explicit.
- [x] Fixed-clock tests cover unknown and missing statuses.
**Likely files:** `src/select.ts`, `test/select.test.ts`.
**Depends on:** #2.

### [#4] [native-agent-routing] OpenCode V2 agent assignment

**Num:** 4

**Status:** completed

**Priority:** critical

**Scope:** Use native agent transform/registration and supported reload to apply choices to bound agents. Preload asynchronous state before synchronous transforms; preserve prompts/permissions, respect explicit user override and test plugin transform order. Never `switchModel` an active turn.
**Acceptance criteria:**
- [x] Bound agent starts next assignment on chosen model; unbound agent unchanged.
- [x] Changed eligibility promotes primary at supported next-assignment boundary only.
- [x] Override and registration-order limitations are verified/documented.
**Likely files:** `src/index.ts`, `src/agent-routing.ts`, `test/agent-routing.test.ts`.
**Depends on:** #3.

### [#5] [test-agent] Dedicated dynamic test agent

**Num:** 5

**Status:** completed

**Priority:** critical

**Scope:** Define read-only `quartermaster-test` subagent, two-candidate plan, synthetic availability fixture, repeatable OpenCode/OpenChamber invocation and observable actual selected model. Distinguish simulated model selection from live host routing.
**Acceptance criteria:**
- [x] Separate new assignments show primary -> backup -> primary when availability changes.
- [x] Unbound agent and explicit user model override remain unchanged.
- [x] Clean-checkout tests and smoke instructions do not depend on exhausting real provider quotas.
**Likely files:** `examples/`, `test/integration/`, `README.md`.
**Depends on:** #4.

### [#6] [usage-rpc-client] Consume cached opencode-usage RPC

**Num:** 6

**Status:** completed

**Priority:** high

**Scope:** Call `ctx.rpc(USAGE_RPC).status({})` per current contract (or a locally typed compatible definition). Validate schema version, timestamps, stale/auth/error, availability and reset data. Missing/mismatched plugin or timeout must not stall startup. Never call provider APIs or force refresh per assignment.
**Acceptance criteria:**
- [x] Synthetic available/limited/unknown/stale snapshots normalize correctly.
- [x] RPC failure/missing/schema mismatch is explicit, not falsely exhausted.
- [x] Tests show Quartermaster does not poll provider APIs directly or force refresh per selection; read-through polling/coalescing remains owned by opencode-usage.
**Likely files:** `src/usage.ts`, `test/usage.test.ts`.
**Depends on:** #3.

### [#7] [quota-eligibility] Map shared quota to models

**Num:** 7

**Status:** completed

**Priority:** high

**Scope:** Map usage source IDs to actual OpenCode provider IDs; confirmed source exhaustion skips all paid models sharing the quota. Support explicit exempt models (e.g. Go free), not inferred model estimates. Distinguish stale/unknown/auth issues from confirmed `limited` and temporary 429 failures.
**Acceptance criteria:**
- [x] Limited source excludes mapped paid models with explanation; configured exemptions remain eligible.
- [x] Unknown/stale follows documented policy and never masquerades as limited.
- [x] Estimated reset alone cannot unblock; fresh available status can.
**Likely files:** `src/eligibility.ts`, `test/eligibility.test.ts`.
**Depends on:** #6.

### [#8] [work-type-routing] Explicit work-type plan resolution

**Num:** 8

**Status:** completed

**Priority:** medium

**Scope:** Accept caller-supplied work-type alias in selection API. Resolve work-type binding before agent binding, handle unknown aliases and explicit model override. Never classify prompts or infer type from agent text.
**Acceptance criteria:**
- [x] Same agent routes differently for explicitly distinct work types.
- [x] Unknown type has documented fallback/error with explanation; agent-only behavior unchanged.
- [x] Precedence has automated checks.
**Likely files:** `src/config.ts`, `src/select.ts`, `test/work-type.test.ts`.
**Depends on:** #3.

### [#9] [provider-cooldown] Temporary failure cooldown

**Num:** 9

**Status:** completed

**Priority:** high

**Scope:** Accept structured failure/success reports from host or Slim; classify temporary provider-level vs model-level outages separately from quota exhaustion, cancellation and generic errors. Expire scoped cooldown using injected clock; no global ban from one model failure.
**Acceptance criteria:**
- [x] Only affected scope skips during configured cooldown and re-enables later.
- [x] Auth/quota/cancellation are not indiscriminately classified as outages.
- [x] Tests cover independent providers, repeated reports, expiry and restart semantics.
**Likely files:** `src/failures.ts`, `test/failures.test.ts`.
**Depends on:** #3.

### [#10] [local-health] Detect offline local endpoints

**Num:** 10

**Status:** completed

**Priority:** medium

**Scope:** Probe only explicitly configured local endpoints with timeout and cached result; configurable endpoint/health URL. No prompts/credentials in health requests. One local outage must not exclude remote models.
**Acceptance criteria:**
- [x] Local down/timeout skips; up is eligible; remote providers are not probed.
- [x] Fake local server tests cover timeout/cache/independent endpoints.
- [x] Restarted local service becomes preferred on a later assignment.
**Likely files:** `src/local-health.ts`, `test/local-health.test.ts`.
**Depends on:** #3.

### [#11] [availability-refresh] Reset-aware eligibility lifecycle

**Num:** 11

**Status:** completed

**Priority:** high

**Scope:** Compose usage, cooldown and local health into cached snapshot. Persist minimal cooldown/reset-gating state via plugin storage as needed; reconcile restart. Skip repeated provider checks for confirmed exhaustion until next usage refresh; after reset estimate require fresh confirmation. Debounce supported agent reload on eligibility changes.
**Acceptance criteria:**
- [x] Repeated assignments under confirmed exhaustion reuse cached status and avoid provider polling.
- [x] Estimated reset alone cannot restore eligibility; fresh available status can.
- [x] Restart, stale input, concurrent assignments and changed availability tested deterministically.
**Likely files:** `src/availability.ts`, `test/availability.test.ts`.
**Depends on:** #4, #7, #9, #10.

### [#12] [pins-and-reasons] Manual pin and explanation

**Num:** 12

**Status:** completed

**Priority:** medium

**Scope:** Pin/unpin configured plan candidates per agent; persist project-wide across sessions in plugin storage, without changing an active session. Explain selected and skipped candidates from structured reason codes. Invalid pins must fail clearly; unavailable pins never bypass eligibility or explicit host model choice.
**Acceptance criteria:**
- [x] Eligible pin wins next assignment; unpin restores plan order.
- [x] Ineligible pin is skipped with reason; no-eligible is visible.
- [x] Tests cover unknown IDs, persistence scope and post-recovery preference.
**Likely files:** `src/pins.ts`, `src/explain.ts`, `test/pins.test.ts`.
**Depends on:** #11.

### [#13] [quartermaster-rpc] Versioned cross-plugin API

**Num:** 13

**Status:** completed

**Priority:** high

**Scope:** Register a V2 RPC for `select({agent, workType?})`, status/reasons, pin/unpin and scoped failure reports. Validate current registry candidates; expose typed no-plan/no-eligible/error results. Support Slim and later GUI without suggesting atomic in-flight switching.
**Acceptance criteria:**
- [x] Another plugin calls RPC and receives model provider/id/variant with stable explanation fields.
- [x] Missing agent, stale status and malformed input are explicit; no secrets in outputs.
- [x] Contract test covers cross-plugin call and absent-service fallback.
**Likely files:** `src/rpc.ts`, `test/rpc.test.ts`, `README.md`.
**Depends on:** #8, #11, #12.

### [#14] [slim-agent-bridge] OMO Slim assignment integration

**Num:** 14

**Status:** cancelled

**Priority:** high

**Scope (Deferred: external consumer adapter):** Not part of the Quartermaster-side plan. If a Slim maintainer opts in later, its separate checkout owns legal assignment integration, precedence and fallback; Quartermaster only supplies the #32 contract. Do not enable unsafe V2 foreground fallback.
**Acceptance criteria:**
- [ ] Opted-in new Slim assignment uses eligible Quartermaster choice; unconfigured agents/explicit overrides retain existing behavior.
- [ ] Missing RPC, error and no-eligible outcome follow documented policy without hang/retry loop.
- [ ] Opt-out preserves Slim semantics; no unsafe V2 `switchModel` path enabled.
**Likely files:** OMO Slim `src/v2/setup.ts`, agent resolution path, config schema, docs/tests (confirm in checkout).
**Depends on:** #13, #5.

### [#15] [slim-integration-tests] Prove Slim and Quartermaster together

**Num:** 15

**Status:** cancelled

**Priority:** high

**Scope (Deferred: external consumer tests):** Slim owns isolated cross-plugin host runs if its adapter is adopted. Quartermaster-only contract and missing-service tests belong to #32 and #30.
**Acceptance criteria:**
- [ ] Separate assignments show primary -> backup -> primary; active turn untouched.
- [ ] Slim alone retains prior behavior; absent service does not deadlock.
- [ ] Automated checks and reproducible host instructions distinguish mock-only from live proof.
**Likely files:** Slim integration tests, Quartermaster `test/integration/`, `README.md`.
**Depends on:** #14.

### [#16] [gui-readonly] Quartermaster web UI: plans and status

**Num:** 16

**Status:** completed

**Priority:** medium

**Scope:** Provide an opt-in local read-only UI that shows configured plans, availability, and the project report from the running plugin. Retain loopback-only startup, server-held credentials, fixed project scope, and no session, model, or config mutations.
**Acceptance criteria:**
- [x] Offline import, explicit live-load button, fixed report request, server-held credentials and text rendering are implemented; stub tests prove only the request path, not live host integration.
- [x] Supported local-service authentication, project/report validation, streaming response limits and security/browser regression tests pass against the running plugin.
- [x] Report values render as text with accessible status and keyboard/narrow-screen support. Documentation covers local-process risks; the tool does not write config, mutate sessions/models, start with the plugin, or mount inside OpenCode's web UI.
- [x] The requested plans/status view is available, or report-only scope is explicitly approved; real OpenCode-to-browser smoke evidence proves live interaction without browser credentials.
**Likely files:** `src/local-ui.mjs`, `web/`, `src/rpc.ts`, `test/local-ui.test.mjs`, `test/ui-offline.test.ts`, `docs/`.
**Depends on:** #25, #34, #35.

### [#17] [gui-editor] Quartermaster web UI: model assignment editor

**Num:** 17

**Status:** completed

**Priority:** medium

**Scope:** The authenticated local page edits plans, models, variants, and agent or work-type bindings through the #33 project writer. The browser does not write the config file or hold the OpenCode token. Cancel discards unsaved edits. Apply changes the next assignment and leaves the current session unchanged.
**Acceptance criteria:**
- [x] Authorized valid edits round-trip through #33 and affect a later assignment after its supported reload path; current sessions stay unchanged.
- [x] Invalid, stale/conflicting, unauthorized and cancelled edits leave the original options and unrelated host settings unchanged; no secrets or write credentials reach the browser.
- [x] Keyboard/accessibility, error/read-only and server-side config tests cover the edit flow; if #33 cannot safely write, #17 stays blocked rather than being marked done.
**Likely files:** `web/`, `src/config.ts`, `src/rpc.ts`, `test/ui/`, `test/rpc.test.ts`.
**Depends on:** #16, #33.

### [#18] [atomic-fallback-gate] Gate future mid-turn failover

**Num:** 18

**Status:** cancelled

**Priority:** low

**Scope (Deferred: external host capability):** Mid-turn conditional model switching requires host atomicity proof in a separate host effort. Quartermaster remains assignment-only; no Slim foreground fallback is enabled.
**Acceptance criteria:**
- [ ] Record exact host API/version and executable overlapping-turn race test, or missing capability and upstream request.
- [ ] No V2 foreground fallback activated without atomicity proof.
- [ ] If capability exists, specify separate Slim retry integration task; distinguish it from assignment.
**Likely files:** `docs/`, upstream host issue/PR only if authorized.
**Depends on:** #15 and external host capability.

### [#19] [openchamber-rpc-bridge] OpenChamber-to-server transport

**Num:** 19

**Status:** completed

**Priority:** high

**Scope:** Verify whether an OpenChamber desktop/web extension can call the *active project's authenticated* V2 Quartermaster RPC without embedding server credentials in panel JavaScript or assuming a fixed local URL. If supported, prototype the smallest documented bridge and disconnect behavior. If unsupported, record the missing capability and threat model, do not add a proxy, and defer the proposed OpenChamber UI at that time; the requested UI is reopened through #36, which must resolve the bridge before dependent features ship. In either case, preserve the server plugin/RPC and retire only the unfinished TUI experiment and its dependencies/exports.
**Acceptance criteria:**
- [x] Verified no supported panel-to-server call is documented; recorded the missing active-server endpoint/auth capability and deferred the proposed GUI at that time without adding an unsafe transport.
- [x] Threat model documents origin, authentication and permissions; no browser-held server secret or unauthenticated endpoint.
- [x] Unfinished TUI files/dependencies are retired without removing server RPC or unrelated work; OpenChamber version/support surface findings are recorded.
**Likely files:** `docs/`, `README.md`, `package.json`, and the retired TUI prototype files.
**Depends on:** #13.

### [#20] [token-telemetry-contract] Establish authoritative token source

**Num:** 20

**Status:** completed

**Priority:** high

**Scope:** Inspect the exact OpenCode V2 event and assistant-message contract for final token counts, model, session/project location and parent session. Define a private record with host message/session/project IDs, provider/model/variant, completion time and separate input/output/reasoning/cache read/write counts plus provenance and missing-data state. Provider is a first-class token dimension; populate it only from evidence correlated to the exact step, and preserve it as unknown when unavailable. Identify duplicate stream updates, retries, compactions and auxiliary calls; never substitute opencode-usage quota percentages.
**Acceptance criteria:**
- [x] Document exact supported host version/API/event, token-field semantics, provider/model attribution limits and authoritative vs missing/estimated records.
- [x] Synthetic streaming, retry, child-session and no-token fixtures do not yield duplicate billable records.
- [x] No prompts, permission details or secrets enter the telemetry contract.
**Likely files:** `docs/TOKEN_TELEMETRY.md`, `src/telemetry/types.ts`, `test/telemetry/`.
**Depends on:** #13.

### [#21] [token-ledger] Durable deduplicated token ingestion

**Num:** 21

**Status:** completed

**Priority:** high

**Scope:** Subscribe to supported live host events and persist #20 records in plugin-scoped server KV, one row per host event ID, so redelivery/restart is idempotent and a revised same-ID record replaces its prior row. Preserve project IDs, including an explicit unknown-project partition, for future project-correct cross-project reports without mixing records. Preserve provider on every token row when exact-step evidence is available; otherwise store provider/model/variant as unknown rather than inferring them. Apply 90-day retention and a 10,000-row cap per project partition; results are limited to 1,000 rows. There is no global row ceiling. The host KV provides atomic per-key upsert but no cross-key transaction/CAS, so concurrent distinct event writes are isolated while simultaneous same-ID revisions are last-write-wins without guaranteed ordering. Live SSE gaps cannot be recovered; failed writes get one retry and unknown usage remains unknown.
**Acceptance criteria:**
- [x] A received terminal host event is stored once across redelivery/restart; a later record with the same host event ID replaces its prior row rather than adding counts.
- [x] Project IDs, provider IDs and missing fields survive persistence; provider/model remain explicitly unknown when exact-step evidence is unavailable. Separate event keys isolate concurrent distinct writes across projects. Same-ID concurrent revisions are last-write-wins without guaranteed ordering.
- [x] Whitelisted metadata retention/listing excludes prompts and credentials; retention is 90 days and at most 10,000 rows per project partition, with up to 1,000 returned rows and no global row ceiling. Missing usage remains unknown.
**Likely files:** `src/telemetry/ledger.ts`, `src/telemetry/collector.ts`, `src/index.ts`, `test/telemetry/`, `docs/TOKEN_TELEMETRY.md`.
**Depends on:** #20.

### [#22] [token-attribution] Opt-in self-reported plugin attribution

**Num:** 22

**Status:** completed

**Priority:** high

**Updated:** 2026-09-29 — replaced blocked host-verified ownership with opt-in self-reported best-effort attribution.

**Scope:** Implement explicitly opt-in, best-effort plugin attribution for Quartermaster's personal usage reports. Cooperating plugins may self-report a stable plugin name/ID and the host session IDs (including child sessions) they claim to own. Attach a `self-reported`/unverified plugin label only to observed token records with an exact matching session ID in the same host-observed project. A name alone is not enough to attribute usage; missing, ambiguous, unmatched or cross-project claims remain unknown. Live event-stream gaps may leave records unreported. Do not describe claims as authenticated or host-verified, and never use them for authorization, cross-project access, routing, eligibility or budget enforcement. Do not infer ownership from prompts or agent names, store content, or double-count child-session records. Provider/model attribution remains independently evidence-based.
**Acceptance criteria:**
- [x] An opt-in cooperating plugin can submit its self-reported name/ID and associated host session IDs; project reports expose matching records as explicitly self-reported/unverified, without changing evidence-based provider/model fields.
- [x] Name-only, missing, ambiguous, unmatched, unknown-project and cross-project claims remain unknown; tests cover two projects, child sessions and duplicate/replayed events without double-counting or leaking other-project data.
- [x] Documentation explains opt-in setup, incomplete live-stream coverage and the unverified nature of claims; self-reported labels are not used for authorization, routing, eligibility or budget enforcement.
**Likely files:** `src/telemetry/attribution.ts`, `src/telemetry/report.ts`, `src/rpc.ts`, `test/telemetry/`, `test/rpc.test.ts`, `docs/TOKEN_TELEMETRY.md`.
**Depends on:** #21, #25.

### [#23] [token-budget-config] User-set token allocations

**Num:** 23

**Status:** completed

**Priority:** high

**Scope:** Validate opt-in Quartermaster-side project budgets and optional provider/model/plugin dimensions over explicit windows. Only use dimensions backed by the #21 ledger; label unverified provider/model/plugin attribution unknown rather than charging it to a guessed owner. Show measured/unknown usage without double-counting overlapping dimensions. Default to reporting/warnings; no price-based optimization or implied spare capacity from missing counts.
**Acceptance criteria:**
- [x] Invalid dimensions, windows and limits reject with actionable paths; examples distinguish a supported project budget from unverified plugin/model attribution.
- [x] Fixed-clock tests cover overlaps, resets, no configured limit and unknown usage without false precision.
- [x] Disabled budgets preserve current plan order and host behavior.
**Likely files:** `src/config.ts`, `src/telemetry/budgets.ts`, `test/telemetry/`, `examples/`.
**Depends on:** #21.

### [#24] [token-budget-gate] Allocation warnings and safe boundaries

**Num:** 24

**Status:** completed

**Priority:** medium

**Scope:** Combine supported Quartermaster budget dimensions with eligibility reasons at Quartermaster-owned *new* assignment boundaries. Return advisory alerts by default; unsupported strict budgets return `cannot-guarantee-hard-cap` unless an atomic reservation and trustworthy request bound are proven. Do not enforce consumer-plugin requests or change an in-flight model. Preserve explicit host choice and explain unknown usage.
**Acceptance criteria:**
- [x] Measured spend and selected window yield structured advisory reasons for Quartermaster-owned assignments; unsupported strict exclusion is rejected explicitly.
- [x] Concurrent requests, uncertain token counts and late usage cannot silently claim a strict cap that is not enforceable; tested with fixed clock.
- [x] Budget-disabled behavior and quota/override/pin precedence remain unchanged; no automatic price-based ranking.
**Likely files:** `src/telemetry/budget-gate.ts`, `src/eligibility.ts`, `test/telemetry/`.
**Depends on:** #23, #11.

### [#25] [token-reporting-rpc] Versioned server reporting API

**Num:** 25

**Status:** completed

**Priority:** high

**Scope:** Extend Quartermaster's V2 RPC contract with bounded, paged project-scoped usage and budget reports, since/until filters, freshness and explicit unknown dimensions. Include #31 observed provider/model error and rate-limit summaries. Never trust anonymous plugin ownership claims or expose cross-project data without a verifiable host authorization boundary; report unsupported dimensions/authorization explicitly. Keep telemetry separate from opencode-usage quota snapshots and preserve existing consumers.
**Acceptance criteria:**
- [x] An authorized client gets versioned bounded project summaries, supported dimension breakdowns, error/rate-limit timestamps and budget values matching ledger fixtures; unavailable attribution is marked unknown.
- [x] Invalid windows, oversized pages, missing service and cross-project access are handled explicitly without leaking prompts/keys.
- [x] An explicit refresh reads updated ledger data without provider polling or duplicate ingest; no GUI implementation is required.
**Likely files:** `src/rpc.ts`, `src/telemetry/report.ts`, `test/rpc.test.ts`.
**Depends on:** #21, #23, #31, #32.

### [#26] [reviewer-model-bridge] Opt-in permission-reviewer selection

**Num:** 26

**Status:** completed

**Priority:** high

**Scope:** In a *separate permission-reviewer checkout/PR*, add trusted-global opt-in to call Quartermaster `select({ agent: "permission-reviewer", workType: "permission-review" })` before creating its isolated V2 reviewer session. An explicitly configured Quartermaster work-type binding (for example `workTypes.permission-review = "review"`) selects the reviewer plan; do not infer the alias from a prompt. Validate enabled model, supported variant and structured-output/text capability; preserve the configured trusted fallback and never let project/inline options select the reviewer model. Direct Jev System One stays on its own backend unless a separately verified compatible path exists.
**Acceptance criteria:**
- [x] Opted-in normal reviewer session uses a compatible Quartermaster candidate; absent RPC, no-plan/no-eligible, timeout and incompatible format fall back to the trusted reviewer model.
- [x] Tool-free isolation, permission policy, deny/escalation behavior, trusted config precedence and explicit user models are unchanged.
- [x] Opt-out and V1 behavior remain unchanged; simulated review and live-host proof are distinguished.
**Likely files:** permission-reviewer V2 backend/config/tests in its own checkout; Quartermaster integration docs.
**Depends on:** #13, #20.

**Verification:** Focused mock tests, lint, typecheck, and build pass in the separate permission-reviewer checkout. Live OpenCode host routing remains unverified; changes are uncommitted.

### [#27] [reviewer-token-link] Reviewer usage attribution

**Num:** 27

**Status:** cancelled

**Priority:** high

**Scope (Deferred: external reviewer adapter and host capability):** Reviewer-owned attribution cannot be proven until #22's host identity/replay/linkage exists. A future separate reviewer effort may opt in; Quartermaster must keep reviewer plugin/model ownership unknown meanwhile.
**Acceptance criteria:**
- [ ] Two projects and multiple reviewer attempts roll up to correct project/plugin/model without duplicating parent session tokens.
- [ ] Reviewer fallback, failed/aborted attempt and direct Jev unknown counts are explicit; no unrelated session is claimed.
- [ ] Attribution is disabled cleanly if the reviewer or Quartermaster is absent, without changing permission decisions.
**Likely files:** permission-reviewer V2 adapter/tests (separate checkout), `src/telemetry/attribution.ts`, `test/integration/`.
**Depends on:** #22, #26.

### [#28] [gui-token-usage] OpenChamber telemetry visualization

**Num:** 28

**Status:** completed

**Priority:** medium

**Scope:** Build an OpenChamber-owned view over Quartermaster's existing project-scoped reports after #36 proves the authenticated active-project bridge. Implement extension code only in a separately authorized OpenChamber checkout; Quartermaster owns the report contract and synthetic contract tests. Show plan/agent breakdowns only on #34's exact evidence and #35 costs only as partial configured-rate estimates; show unknown/unpriced amounts, not zero or a complete bill. Without bridge or authorized extension ownership, leave #28 pending.
**Acceptance criteria:**
- [x] Project totals, evidenced plan/agent usage, unknown attribution and partially priced tokens match #25/#34/#35 contract fixtures; rates/currency and unpriced amounts are labeled, never called billed cost.
- [x] The supported #36 handoff is exercised for active-project switching, refresh/disconnect/errors and narrow viewport without browser credentials, fixed endpoints or cross-project reads.
- [x] Extension ownership/authorization, accessibility, version compatibility and manual OpenChamber smoke evidence are recorded; no Quartermaster-only mock is called a shipped OpenChamber panel.
**Likely files:** OpenChamber extension, `test/ui/`, `docs/`.
**Depends on:** #25, #34, #35, #36.
**Verification:** The OpenChamber built-in panel targets engine `>=2.0.0` and requests separate `quartermaster` read and `quartermaster-options` write grants. Panel tests pass (3 tests, 58 assertions); extension typecheck/build and web build pass; Quartermaster tests pass (106) with typecheck. Disposable report smoke verified 3 records/24 tokens/1 unknown, `$0.000108` partial and not billed, offline error preservation and recovery. The 768px desktop smoke confirmed panel bounds, keyboard focus, and accessible labels/status; prior #36 smoke covered project switching and disconnect.

### [#29] [gui-token-budgets] OpenChamber allocation editor

**Num:** 29

**Status:** completed

**Priority:** medium

**Scope:** Add OpenChamber-owned editing for Quartermaster plan/model/variant, agent/work-type bindings and existing budget options through the *same* proven #33 authorized write path and #36 supported bridge; work in a separately authorized OpenChamber checkout. Do not duplicate validation/persistence, proxy with extension credentials, claim enforceable budget caps or change an active model. If either write path or bridge is unsupported, #29 stays blocked, not complete.
**Acceptance criteria:**
- [x] Authenticated, active-project plan/model/variant, agent-binding and budget edits validate and round-trip through #33 without overwriting unrelated options; unauthorized, stale and cancelled edits persist nothing.
- [x] Preview explains windows, unknown coverage and advisory/unsupported-strict semantics; changes affect later assignments only, never in-flight models.
- [x] #36 permission/project boundary, keyboard/accessibility, error/read-only and refresh/reload paths are tested in an authorized OpenChamber extension checkout; otherwise task remains blocked.
**Likely files:** OpenChamber extension, `src/config.ts`, `src/rpc.ts`, `test/ui/`.
**Depends on:** #24, #33, #36.
**Verification:** In the disposable authorized panel, plans/models/variant, agent/work-type bindings and budget saved, reloaded, and restored; project A comments and project B stayed unchanged. Options smokes passed invalid/stale rejection, reload, and successful budget roundtrip; the read-only grant smoke confirmed `NOT_GRANTED`. Tests cover bridge abort on project/grant change, pre-aborted RPC no-write, and writer rollback after abort; no single delayed browser-to-RPC cancellation run was performed. Panel and Quartermaster tests cover preview semantics, keyboard/accessibility, read-only/error and reload behavior.

### [#30] [token-integration-tests] Reconcile Quartermaster ledger and RPC

**Num:** 30

**Status:** completed

**Priority:** medium

**Scope:** Run Quartermaster-owned synthetic and, where available, isolated live-host OpenCode V2 checks across two projects, normal/subagent sessions, budget windows, provider/model attribution, error/rate-limit history and absent-RPC scenarios. Reconcile authoritative observed messages with the ledger and reporting RPC without spending quota to induce exhaustion. External plugin and GUI adapters are not part of this task.
**Acceptance criteria:**
- [x] Project and evidenced provider/model totals reconcile to deduplicated host messages; unknown ownership or direct calls are labeled unknown, not zero, and errors retain observed timestamps and attribution confidence.
- [x] Replays, restarts, concurrent assignments and absent service preserve permission policy and active session model; unsupported hard caps are not claimed.
- [x] Reproducible Quartermaster-only instructions distinguish synthetic from live-host proof and list unsupported host capabilities without relying on fork or GUI tests.
**Likely files:** `test/integration/`, `test/telemetry/`, `test/rpc.test.ts`, `docs/`.
**Depends on:** #24, #25, #31, #32.

### [#31] [provider-error-telemetry] Timestamped provider/model errors and rate limits

**Num:** 31

**Status:** completed

**Priority:** high

**Scope:** Establish and persist a bounded metadata-only history of observed request/provider failures, especially rate limits. Use supported host error hooks/events; record observation time, source, classification (including rate-limit/429 when explicitly known), provider and model only when the source establishes them, and relevant host event/request identity where available. If the host provides no stable failure ID, identify local observations without claiming host replay deduplication. Keep absent attribution explicitly unknown; do not infer from prompts, agent names, current session model or arbitrary caller-supplied IDs. Never persist raw prompts, response/error bodies, credentials or permission contents. Do not confuse quota-limit snapshots with request error events or claim that every error is observable.
**Acceptance criteria:**
- [x] Verified event/API sources and limitations are documented; synthetic tests cover rate limits, other provider/model failures, missing fields, duplicate-ID upserts (without claiming host replay deduplication) and absence of observed events.
- [x] Stored records include observation timestamp, source and normalized classification; provider/model remain explicitly unknown unless backed by the observed event/request, and raw error content/secrets are excluded.
- [x] Bounded retention/query behavior supports later reporting by time, provider and model without changing routing/cooldown semantics or claiming complete error capture.
**Likely files:** `src/telemetry/errors.ts`, `src/telemetry/ledger.ts` or a separate error ledger, `src/index.ts`, `src/rpc.ts`, `test/telemetry/`, `docs/`.
**Depends on:** #9, #20, #21.

### [#32] [plugin-interface-contract] Quartermaster-owned consumer interface

**Num:** 32

**Status:** completed

**Priority:** high

**Scope:** Stabilize and document Quartermaster's exported V2 RPC descriptor and bounded selection helper so independently owned plugins can integrate without importing private state. Keep the implementation and contract tests in Quartermaster; consumer adapters are external and not part of this plan. Preserve existing method names and version-1 selection behavior or specify a compatible migration.
**Acceptance criteria:**
- [x] `quartermaster/rpc` exposes a versioned selection contract with provider/model/variant, structured selected/no-plan/no-eligible/unavailable outcomes, and clear optional work-type routing and precedence.
- [x] Quartermaster-side tests cover malformed or missing service responses, timeout/abort, candidate eligibility and opt-out-safe caller fallback; no request or synchronous transform hangs or retries indefinitely.
- [x] `docs/PLUGIN_INTEGRATION.md` documents consumer setup, assignment-time versus active-session boundaries, explicit override priority and absence behavior without requiring edits in Slim, reviewer or GUI repositories.
**Likely files:** `src/rpc.ts`, `test/rpc.test.ts`, `docs/PLUGIN_INTEGRATION.md`, `README.md`.
**Depends on:** #13.

### [#33] [plan-config-rpc] Opt-in live project options editor

**Num:** 33

**Status:** completed

**Priority:** high

**Updated:** 2026-10-03 — aligned the offline fallback and live writer contract with the completed local and OpenChamber editors.

**Scope:** The offline JSON draft exporter remains a syntax-only fallback. The opt-in local gateway loads and applies Quartermaster options through the shared project writer for its configured directory only. Quartermaster also exposes `readOptions` and `applyOptions` RPC methods bound to the plugin's project directory; the calling host must authorize access, and OpenChamber requires the separate `quartermaster-options` grant. Both paths use the same validation, revision checks and persistence, not OpenCode's global config update API. The writer preserves JSONC and unrelated settings, requires exactly one unambiguous project Quartermaster entry, validates with `parseConfig`, and fails on a stale revision or a failed write. The plugin reads the project file again before later assignments without changing an active session model. #17 and #29 are completed; #29 uses the separately implemented #36 OpenChamber bridge.
**Acceptance criteria:**
- [x] The opt-in offline page accepts a JSON object, rejects invalid/non-object JSON, and downloads a formatted draft without network access or writing host configuration.
- [x] The offline draft page clearly states it does not run `parseConfig` semantic validation, preserve JSONC comments, resolve project-config precedence, or apply the draft; manual review and merge are required.
- [x] `web/README.md` documents the offline fallback, opt-in live flow and local-process risks. `docs/PLUGIN_INTEGRATION.md` describes the project-bound options RPC and host authorization boundary; the `quartermaster` report grant stays read-only, separate from `quartermaster-options`.
- [x] A live editor updates only the intended project’s effective Quartermaster `plugins[].options`, preserving JSONC comments and unrelated settings without touching global configuration.
- [x] The writer resolves config precedence and duplicate plugin entries safely, validates the draft with `parseConfig`, and fails closed on ambiguity or concurrent changes.
- [x] Applying changes is explicit and recoverable; tests cover wrong-project scope, malformed config, duplicate entries and keys, stale revisions, invalid options, cancellation and write failure. Backups and rollback preserve the original configuration on tested failures; saved options are read at later assignment boundaries.
**Likely files:** `src/project-options.ts`, `src/rpc.ts`, `src/config.ts`, `src/local-ui.mjs`, `web/`, `test/project-options.test.ts`, `test/rpc.test.ts`, `test/local-ui.test.mjs`, `docs/PLUGIN_INTEGRATION.md`.
**Depends on:** #2, #13.

### [#34] [session-plan-attribution] Evidence-based session-to-plan/agent reporting

**Num:** 34

**Status:** completed

**Priority:** high

**Scope:** Extend the #25 report with agent and plan dimensions only from independently evidenced host step/message identity and a contemporaneous assignment/selection decision linked to that same step (or a proven immutable session assignment spanning it). A session may change agent/model, while global synchronous `agent.transform` has no session ID; a configured binding, current session model, later config, work-type guess, pin or #22 self-report does not establish which plan produced past usage. Inspect supported hooks for an exact join; if they expose only agent/model, report evidenced agent where possible and leave plan unknown. Missing host capability must not turn an inferred binding into a verified plan. Do not change routing, eligibility or budgets.
**Acceptance criteria:**
- [x] Host-evidenced agent identity and, only where an exact step-linked (or proven immutable session-interval) assignment decision exists, plan identity join deduplicated token rows; report separate confidence/unknown counts for each dimension, with no change to provider/model attribution.
- [x] Explicit overrides, work types, pins, config changes, missing/ambiguous/stale links and self-reported #22 labels cannot fabricate plan/agent attribution; child sessions and event replays do not double-count.
- [x] Fixed fixtures cover two projects, parent/child sessions, agent switches within one session and a missing-plan-evidence path; the scoped report exposes no session IDs, and unsupported live-host joins are documented as unknown rather than passing a synthetic test off as live proof.
**Likely files:** `src/telemetry/`, `src/agent-routing.ts`, `src/index.ts`, `test/telemetry/`, `test/integration/`.
**Depends on:** #4, #21, #25.

### [#35] [token-cost-estimates] Estimated token costs from configured rates

**Num:** 35

**Status:** completed

**Priority:** medium

**Scope:** Validate user-maintained input/output rates per provider/model (and variant where its price differs), unit and currency. Estimate a *priced observed subtotal* only for records with evidenced model identity and usable counts; current collector normally lacks exact model evidence, so an unpriced/unknown bucket may dominate. Treat rates as an as-of report-time estimate, not historical invoices; surface rate source/time, partial coverage and separate currencies instead of silently summing them. Never add overlapping reasoning/cache components to input+output or use price for routing, budgets or provider polling.
**Acceptance criteria:**
- [x] Validated fixed-rate tests cover per-unit input/output math, exact provider/model/variant matching, incomplete counts, missing rates, revised rates and overlapping reasoning/cache fields without double-counting or false precision.
- [x] #25 reports show per-currency known subtotal, unpriced token/record coverage, configured rate source and as-of time; no conversion/mixed-currency total or complete/billed-cost claim when attribution or coverage is missing.
- [x] No estimate alters selection, eligibility, budgets or provider polling; synthetic evidenced-model fixtures are distinguished from live collector records whose model is unknown.
**Likely files:** `src/config.ts`, `src/telemetry/`, `src/rpc.ts`, `test/telemetry/`, `docs/`.
**Depends on:** #21, #25.

### [#36] [openchamber-project-bridge] Authenticated active-project OpenChamber bridge

**Num:** 36

**Status:** completed

**Priority:** high

**Review / completed (2026-10-01):** The maintainer-authorized OpenChamber implementation adds SDK wire-v1 `host.quartermaster` and routes its fixed read-only methods through the authenticated, directory-scoped OpenCode client. A disposable live host authenticated status/report calls for project A and B, followed an active-project switch without guest-supplied scope, and canceled a paused request when the guest was disabled. The guest was re-enabled with only the `quartermaster` grant and returned a fresh project-B report. See [live smoke evidence](OPENCHAMBER_BRIDGE.md). The stale-directory/runtime/frame guards were source-reviewed; the automated UI test covers in-flight grant revocation. #28/#29 remain unchanged and pending their own authorized scope.

**Scope:** Recheck #19's negative finding against the targeted OpenChamber host/SDK and OpenCode V2 versions. Complete #36 *only* by demonstrating a supported, host-mediated authenticated call from the OpenChamber UI to the active project's Quartermaster RPC with project switch/disconnect isolation; Quartermaster owns the contract/evidence, while extension implementation requires separate checkout authorization. OpenChamber `host.request` targeting a manifest API origin and `serviceRequest` targeting its own service are not automatically active-server auth handoffs. Do not invent a credential relay, broad-privilege proxy, fixed localhost URL or unauthenticated endpoint. If no supported handoff exists, document evidence and keep #36 pending (or explicitly ignore it) and #28/#29 blocked; do not mark a negative finding completed.
**Acceptance criteria:**
- [x] Versioned supported OpenChamber API carries active-project location and host authorization to Quartermaster RPC without exposing OpenCode credentials to extension/browser code; a real host smoke test is distinguished from mocks.
- [x] Project switch, mismatch, missing RPC and disconnect fail closed without cross-project data, fixed endpoint, implicit proxy or extra unauthenticated listener.
- [x] #19 findings and the required separately authorized extension owner are recorded. If the capability is absent, document the blocker but leave #36 incomplete and #28/#29 blocked.
**Likely files:** `docs/OPENCHAMBER_BRIDGE.md`, OpenChamber integration boundary, `test/`.
**Depends on:** #19, #25.

## Implementation order

1. ✅ #1 `project-scaffold` -> ✅ #2 `plan-config` -> ✅ #3 `model-selector`.
2. ✅ #4 `native-agent-routing` -> ✅ #5 `test-agent`: **first milestone**, no Slim required.
3. ✅ #6 `usage-rpc-client` -> ✅ #7 `quota-eligibility` -> ✅ #8 `work-type-routing`; ✅ #9 `provider-cooldown` and ✅ #10 `local-health` can begin after #3 independently.
4. ✅ #11 `availability-refresh` -> ✅ #12 `pins-and-reasons` -> ✅ #13 `quartermaster-rpc`.
5. ✅ #19 `openchamber-rpc-bridge`, ✅ #20 `token-telemetry-contract`, ✅ #21 `token-ledger`, ✅ #26 `reviewer-model-bridge` and ✅ #31 `provider-error-telemetry` are historical completed work; none requires new work in a fork.
6. ✅ #32 `plugin-interface-contract`: Quartermaster-owned contract and consumer guidance; no consumer implementation.
7. ✅ #23 `token-budget-config` after #21; then ✅ #24 `token-budget-gate` (advisory only) and ✅ #25 `token-reporting-rpc` (unknown-aware, after #32) independently.
8. ✅ #30 `token-integration-tests` after #24, #25, #31 and #32: Quartermaster-only evidence; unrelated Slim/reviewer adapters remain deferred.
9. ✅ #22 `token-attribution`: opt-in self-reported plugin labels for exactly matched, project-scoped observed records; best-effort only, after #21 and #25.
10. ✅ #34 `session-plan-attribution` -> ✅ #35 `token-cost-estimates`; #33 `plan-config-rpc` is completed. ✅ #36 `openchamber-project-bridge` is implemented and smoke-tested; #19 remains historical research.
11. ✅ #16 `gui-readonly` after #25/#34/#35: opt-in loopback plans, availability, and report view checked against the configured project. #17 `gui-editor` is completed on that page.
12. ✅ #28 `gui-token-usage` and ✅ #29 `gui-token-budgets` after the #36 bridge, separate OpenChamber extension authorization, and #33 writes; completion evidence is recorded under each task.

## Ignored

No tasks are currently ignored.
