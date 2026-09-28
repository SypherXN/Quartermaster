---
name: Quartermaster Agent Model Allocation
overview: Native OpenCode V2 agent plans, usage-aware assignment, OMO Slim bridge and later GUI. Detailed acceptance criteria in docs/IMPLEMENTATION_PLAN.md.
todos:
  - id: project-scaffold
    num: 1
    content: Set up native V2 plugin package and runnable checks
    status: completed
  - id: plan-config
    num: 2
    content: Define validated named plans and binding configuration
    status: completed
  - id: model-selector
    num: 3
    content: Build deterministic ordered eligibility selector
    status: completed
  - id: native-agent-routing
    num: 4
    content: Assign native V2 agents at safe lifecycle boundaries
    status: completed
  - id: test-agent
    num: 5
    content: Prove dynamic selection with dedicated test agent
    status: completed
  - id: usage-rpc-client
    num: 6
    content: Read cached opencode-usage RPC safely
    status: completed
  - id: quota-eligibility
    num: 7
    content: Map shared provider quotas and explicit exemptions
    status: completed
  - id: work-type-routing
    num: 8
    content: Support caller-supplied work-type plan binding
    status: completed
  - id: provider-cooldown
    num: 9
    content: Track scoped temporary failures and cooldown
    status: completed
  - id: local-health
    num: 10
    content: Probe configured local endpoints with timeout
    status: completed
  - id: availability-refresh
    num: 11
    content: Coordinate quota reset confirmation and agent reload
    status: completed
  - id: pins-and-reasons
    num: 12
    content: Add safe pin/unpin and why-this-model reasons
    status: completed
  - id: quartermaster-rpc
    num: 13
    content: Publish versioned cross-plugin selection API
    status: completed
  - id: slim-agent-bridge
    num: 14
    content: Opt OMO Slim into Quartermaster assignment
    status: pending
  - id: slim-integration-tests
    num: 15
    content: Verify Slim routing and missing-service behavior
    status: pending
  - id: gui-readonly
    num: 16
    content: Later optional plan and status viewer
    status: pending
  - id: gui-editor
    num: 17
    content: Later validated GUI configuration editing
    status: pending
  - id: atomic-fallback-gate
    num: 18
    content: Establish host safety gate for future mid-turn fallback
    status: pending
isProject: true
---

# Quartermaster agent model allocation

**Reference doc:** [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md). It contains the full scope, examples, verification strategy, files and acceptance criteria for every ID. This tracker mirrors statuses; update both after implementation.

## Task index

| # | id | status | what implementing does |
|---|---|---|---|
| 1 | `project-scaffold` | completed | V2 plugin package and checks |
| 2 | `plan-config` | completed | Validate named plans and bindings |
| 3 | `model-selector` | completed | Pure ordered selection with reasons |
| 4 | `native-agent-routing` | completed | Native V2 agent assignment |
| 5 | `test-agent` | completed | Standalone dynamic agent proof |
| 6 | `usage-rpc-client` | completed | Consume cached usage RPC |
| 7 | `quota-eligibility` | completed | Apply shared quotas and exemptions |
| 8 | `work-type-routing` | completed | Explicit work-type binding |
| 9 | `provider-cooldown` | completed | Scoped outage cooldown |
| 10 | `local-health` | completed | Local endpoint availability |
| 11 | `availability-refresh` | completed | Reset-aware eligibility lifecycle |
| 12 | `pins-and-reasons` | completed | Manual control and explanation |
| 13 | `quartermaster-rpc` | completed | Cross-plugin contract |
| 14 | `slim-agent-bridge` | pending | Slim agent assignment bridge |
| 15 | `slim-integration-tests` | pending | Cross-plugin host proof |
| 16 | `gui-readonly` | pending | Later optional status viewer |
| 17 | `gui-editor` | pending | Later optional config editor |
| 18 | `atomic-fallback-gate` | pending | Host mid-turn safety prerequisite |

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

**Status:** pending

**Priority:** high

**Scope:** In a *separate OMO Slim checkout/PR*, add opt-in consultation of Quartermaster at legal agent assignment boundary. Decide ordering relative to presets, variants, foreground/background agents and explicit user override. Query asynchronously before synchronous agent transforms, not inside them; respect missing RPC and no-eligible policy. Keep automatic V2 foreground fallback disabled.
**Acceptance criteria:**
- [ ] Opted-in new Slim assignment uses eligible Quartermaster choice; unconfigured agents/explicit overrides retain existing behavior.
- [ ] Missing RPC, error and no-eligible outcome follow documented policy without hang/retry loop.
- [ ] Opt-out preserves Slim semantics; no unsafe V2 `switchModel` path enabled.
**Likely files:** OMO Slim `src/v2/setup.ts`, agent resolution path, config schema, docs/tests (confirm in checkout).
**Depends on:** #13, #5.

### [#15] [slim-integration-tests] Prove Slim and Quartermaster together

**Num:** 15

**Status:** pending

**Priority:** high

**Scope:** Isolated host runs of `quartermaster-test` through Slim: primary/blocked/recovered/pinned, optional explicit work type, override, absent RPC and registration order. Record actual host selection vs RPC recommendation, and test Slim with integration disabled.
**Acceptance criteria:**
- [ ] Separate assignments show primary -> backup -> primary; active turn untouched.
- [ ] Slim alone retains prior behavior; absent service does not deadlock.
- [ ] Automated checks and reproducible host instructions distinguish mock-only from live proof.
**Likely files:** Slim integration tests, Quartermaster `test/integration/`, `README.md`.
**Depends on:** #14.

### [#16] [gui-readonly] Optional GUI: plans and status

**Num:** 16

**Status:** pending

**Priority:** low

**Scope:** After RPC stabilizes, investigate supported V2/OpenChamber UI extension and present plans, bindings, availability, refresh time, pins and selection reasons via Quartermaster RPC. Avoid standalone web server/framework unless needed; config-only use must remain possible.
**Acceptance criteria:**
- [ ] Read-only UI shows live RPC state and missing/unknown status without secrets or duplicate polling.
- [ ] Multiple plans and narrow viewport remain usable; changes appear after refresh.
- [ ] UI support limitations and smoke test are documented.
**Likely files:** `src/ui/` or supported host extension after investigation.
**Depends on:** #13, #15.

### [#17] [gui-editor] Optional GUI: validated configuration editor

**Num:** 17

**Status:** pending

**Priority:** low

**Scope:** Create/edit/delete plans, reorder candidates, change agent/work-type bindings; validate using #2, preview decision, save/reload without overwriting unrelated settings. Offer cancel path; never store credentials.
**Acceptance criteria:**
- [ ] User edits, saves, reloads and sees next assignment change.
- [ ] Invalid/unsaved edits cannot corrupt old config; unrelated settings survive.
- [ ] Automated round-trip and manual keyboard/accessibility smoke check.
**Likely files:** `src/ui/`, `test/ui/` or host-supported extension.
**Depends on:** #16, #2.

### [#18] [atomic-fallback-gate] Gate future mid-turn failover

**Num:** 18

**Status:** pending

**Priority:** low

**Scope:** Separately establish/propose OpenCode V2 atomic *per-turn conditional* model switch/retry selection. Reproduce race where an old switch commits after a newer turn starts. Do not enable Slim V2 foreground fallback merely because `switchModel` exists. Follow-up coding needs new task(s) after capability is proven.
**Acceptance criteria:**
- [ ] Record exact host API/version and executable overlapping-turn race test, or missing capability and upstream request.
- [ ] No V2 foreground fallback activated without atomicity proof.
- [ ] If capability exists, specify separate Slim retry integration task; distinguish it from assignment.
**Likely files:** `docs/`, upstream host issue/PR only if authorized.
**Depends on:** #15 and external host capability.

## Implementation order

1. ✅ #1 `project-scaffold` -> ✅ #2 `plan-config` -> ✅ #3 `model-selector`.
2. ✅ #4 `native-agent-routing` -> ✅ #5 `test-agent`: **first milestone**, no Slim required.
3. ✅ #6 `usage-rpc-client` -> ✅ #7 `quota-eligibility` -> ✅ #8 `work-type-routing`; ✅ #9 `provider-cooldown` and ✅ #10 `local-health` can begin after #3 independently.
4. ✅ #11 `availability-refresh` -> ✅ #12 `pins-and-reasons` -> ✅ #13 `quartermaster-rpc`.
5. #14 `slim-agent-bridge` -> #15 `slim-integration-tests`: **second milestone**.
6. #16 `gui-readonly` -> #17 `gui-editor`: **later optional GUI**.
7. #18 `atomic-fallback-gate`: independent future host capability gate; does not block agent assignment.
