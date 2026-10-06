# Exclusive local model

One opt-in local model, such as Qwen on ninfer, is guarded by an in-memory lease manager per Quartermaster plugin instance. Within that instance, another session — including another chat with the same agent — is given its next eligible candidate. The holding session keeps the model until that turn ends, and the next prompt chooses again. Separate project/plugin instances and OpenCode processes do not share leases. This is not a ninfer client, a free-model routing call, or a mid-turn model switch.

## Task index

| # | id | status | summary |
|---|-----|--------|---------|
| 1 | `exclusive-config` | completed | Opt-in `exclusiveModels` list |
| 2 | `exclusive-lease` | completed | In-memory one-holder lease |
| 3 | `exclusive-routing` | completed | Skip a busy model during session prompt routing |
| 4 | `exclusive-gate` | completed | Hold the slot across the provider call |

## Assumptions

- The user names the model as `providerID/modelID` from `opencode models`. ninfer is that provider, not a special integration.
- The slot is per listed model, inside one Quartermaster plugin instance only. Separate project/plugin instances and OpenCode processes do not share it.
- The session that holds the slot keeps it until the turn ends. A later prompt chooses again.
- A different session does not wait when its plan has another candidate. A request already aimed at the busy model still waits.
- An in-flight turn is not switched. A session model outside the agent's plan is left alone.
- An empty `exclusiveModels` list keeps today's behavior.

## Task details

### [#1] [exclusive-config] Opt-in exclusive models

**Num:** 1

**Status:** completed

**Priority:** high

**Scope:** Accept `exclusiveModels` as an array of `providerID/modelID` strings. Reuse the existing model-id checks: non-empty, no duplicates, no surrounding whitespace. Default to an empty list. Do not require a `localEndpoints` entry. Do not add a ninfer URL, a queue length, or a configurable timeout in this task.
**Acceptance criteria:**
- [x] A missing `exclusiveModels` field parses as an empty list and existing configs still parse.
- [x] Valid ids are stored as model refs. Duplicates, blank strings, and ids without a provider slash fail validation.
- [x] README and `examples/quartermaster.json` show one exclusive local model beside its loopback health URL.
**Files:** `src/config.ts`, `test/config.test.ts`, `README.md`, `examples/quartermaster.json`
**Depends on:** none

### [#2] [exclusive-lease] One holder per model

**Num:** 2

**Status:** completed

**Priority:** high

**Scope/current behavior:** Add an in-memory lease keyed by `providerID/modelID`. A session acquires the slot only when it is free or already held by that same session. The prompt reservation is held through the execution and step end/failure does not free it; `session.execution.succeeded`, `.failed`, or `.interrupted` finishes the reservation. A missed finish expires the slot 15 minutes after the last acquire or `session.step.streamed` refresh. The lease is not written to plugin storage and is not shared between plugin instances.
**Acceptance criteria:**
- [x] A second session cannot acquire a held model. The holding session can acquire again.
- [x] Step ended/failed events update lease state; prompt reservation remains until the session execution finishes.
- [x] A streamed event keeps the holder past the original acquire time. A silent holder expires after 15 minutes.
- [x] Tests cover these cases with an injected clock and do not open a port or call ninfer.
**Files:** `src/exclusive.ts`, `test/exclusive.test.ts`
**Depends on:** #1

### [#3] [exclusive-routing] Skip a busy model

**Num:** 3

**Status:** completed

**Priority:** high

**Scope/current behavior:** While a lease is held, session-aware routing skips that model for every session except the lease-owning session, with reason `exclusive-busy`. A caller that omits session ID treats every held model as busy. Agent transform itself does not consult lease state; prompt-time routing does. Lease changes do not reload the agent catalog.
**Acceptance criteria:**
- [x] With the slot free, the exclusive model remains the first eligible candidate.
- [x] With another session holding it, session-aware prompt selection takes the following eligible candidate and explanation uses `exclusive-busy`.
- [x] The holding agent still selects that model. A pin on a busy exclusive model is skipped.
- [x] Session-aware prompt routing responds to lease state; agent-catalog reload is not used for lease changes.
**Files:** `src/select.ts`, `src/explain.ts`, `src/agent-routing.ts`, `test/select.test.ts`, `test/agent-routing.test.ts`
**Depends on:** #2

### [#4] [exclusive-gate] One in-flight provider call

**Num:** 4

**Status:** completed

**Priority:** high

**Scope/current behavior:** Register `session.hook("model.request")` for each configured exclusive model provider. Primary requests acquire/wait for a lease; the hook does not retarget an already-started request. Stream events refresh expiry. Step ended/failed release the turn reservation only when a subsequent execution-finished event arrives. Compaction, title, and generate calls are unchanged and are not gated. These hook registrations use startup config; changing `exclusiveModels` requires plugin restart.
**Acceptance criteria:**
- [x] Two overlapping primary requests for the same exclusive model result in one acquire before the first returns; step end/failure alone does not release the prompt reservation, which lasts through execution completion.
- [x] A request for a non-exclusive model, or a non-primary kind, does not take the slot.
- [x] A request already aimed at the busy model is not moved to another model mid-turn.
- [x] Disposal removes the hook and the event subscription.
**Files:** `src/agent-routing.ts`, `src/index.ts`, `test/exclusive.test.ts`
**Depends on:** #3

## Implementation order

1. ✅ #1 `exclusive-config`
2. ✅ #2 `exclusive-lease`
3. ✅ #3 `exclusive-routing`
4. ✅ #4 `exclusive-gate`

## Out of scope

- Sharing the slot across operating-system processes or machines.
- Talking to ninfer beyond the existing loopback health GET.
- Queuing a visible wait in the UI, or switching an in-flight session to a backup model.
- Treating every local endpoint as exclusive. Only listed models take a slot.
