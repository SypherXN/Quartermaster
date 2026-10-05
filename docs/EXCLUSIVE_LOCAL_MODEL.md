# Exclusive local model

One opt-in local model, such as Qwen on ninfer, may be used by one session in this OpenCode process. On each new prompt, another session — including another chat with the same agent — is given its next eligible candidate. The holding session keeps the model until that turn ends, and the next prompt chooses again. This is not a cross-process lock, a ninfer client, a free-model routing call, or a mid-turn model switch.

## Task index

| # | id | status | summary |
|---|-----|--------|---------|
| 1 | `exclusive-config` | completed | Opt-in `exclusiveModels` list |
| 2 | `exclusive-lease` | completed | In-memory one-holder lease |
| 3 | `exclusive-routing` | completed | Skip a busy model and reload agents |
| 4 | `exclusive-gate` | completed | Hold the slot across the provider call |

## Assumptions

- The user names the model as `providerID/modelID` from `opencode models`. ninfer is that provider, not a special integration.
- The slot is per listed model, inside the plugin process only. Two OpenCode processes do not share it.
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

**Scope:** Add an in-memory lease keyed by `providerID/modelID`. A session acquires the slot only when it is free or already held by that same session. Acquisition counts nested calls from that session. `session.step.ended` and `session.step.failed` release one count, and the slot frees at zero. A missed end event expires the slot 15 minutes after the last acquire or `session.step.streamed` refresh. The lease is not written to plugin storage.
**Acceptance criteria:**
- [x] A second session cannot acquire a held model. The holding session can acquire again.
- [x] Ended and failed events release one nested hold, including when the event has no matching hold.
- [x] A streamed event keeps the holder past the original acquire time. A silent holder expires after 15 minutes.
- [x] Tests cover these cases with an injected clock and do not open a port or call ninfer.
**Files:** `src/exclusive.ts`, `test/exclusive.test.ts`
**Depends on:** #1

### [#3] [exclusive-routing] Skip a busy model

**Num:** 3

**Status:** completed

**Priority:** high

**Scope:** While a lease is held, `selectModel` skips that model for every agent except the holding session's agent, with skip reason `exclusive-busy`. The holding agent keeps the model. Releasing the slot or acquiring it requests the existing debounced agent reload so the next assignment can take the model or move off it. `explain` includes the new reason. Pins still do not bypass this skip.
**Acceptance criteria:**
- [x] With the slot free, the exclusive model remains the first eligible candidate.
- [x] With another session holding it, the next agent gets the following eligible candidate, and the explanation uses `exclusive-busy`.
- [x] The holding agent still selects that model. A pin on a busy exclusive model is skipped.
- [x] Acquire and release call the existing reload path once per change, not on an unchanged eligibility snapshot.
**Files:** `src/select.ts`, `src/explain.ts`, `src/agent-routing.ts`, `test/select.test.ts`, `test/agent-routing.test.ts`
**Depends on:** #2

### [#4] [exclusive-gate] One in-flight provider call

**Num:** 4

**Status:** completed

**Priority:** high

**Scope:** Register `session.hook("model.request")` for each exclusive model's provider. Before that call proceeds, acquire the lease for its session. If another session holds it, wait until release or the 15-minute expiry, then acquire. Do not change `model`, call `switchModel`, or retarget the URL. Release through the step ended and failed events from #2, and refresh expiry on streamed events. Limit the hook to `kind: "primary"`. Compaction, title, and generate calls are unchanged.
**Acceptance criteria:**
- [x] Two overlapping primary requests for the same exclusive model result in one acquire before the first returns, and the second proceeds only after ended or failed.
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
