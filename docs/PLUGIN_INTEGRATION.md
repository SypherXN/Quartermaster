# Integrating Other Plugins

Quartermaster exposes model routing through the OpenCode V2 plugin RPC
boundary. Consumers should use this RPC, not import Quartermaster internals
or read its private state.

The canonical descriptor and helper are exported from `opencode-quartermaster/rpc`.
Install the versioned local archive (see the README), then import that same
installed copy. The package is not published; checkout installs need a build.

## Assignment-time selection

Call `requestSelection` from async plugin setup before registering a
synchronous transform. Cache the result and apply it in the transform; never
await RPC inside the callback.

```ts
import { requestSelection } from 'opencode-quartermaster/rpc'

const result = await requestSelection(ctx, { agent: 'reviewer' })
await ctx.agent.transform((draft) => {
  if (result.status !== 'selected') return
  const { providerID, modelID, variant } = result.selected
  // These checks come from the consumer's own config and allowed models.
  if (hasExplicitOverride || !allowedModelIDs.has(`${providerID}/${modelID}`)) {
    return;
  }
  draft.update('reviewer', (agent) => {
    agent.model = {
      providerID,
      id: modelID,
      ...(variant === undefined ? {} : { variant }),
    };
  });
});
```

## Direct-call module profiles

`modules` is an optional map in `quartermaster.jsonc`, separate
from native `plans`, `agents` and `workTypes`. It is intended for consumers such
as OPR's direct System One transport, which bypasses OpenCode's chat hooks. A
module is a static profile, not an executable loader or a Jev client.

```json
{
  "modules": {
    "opr-jev": {
      "cooldownMs": 300000,
      "models": [
        { "id": "opencode/jev-1.13-free", "cooldownMs": 900000 },
        "opencode/jev-1.13"
      ]
    }
  }
}
```

Configuration rules:

- Module names are nonempty strings without surrounding whitespace. Each value
  accepts only `models` and optional `cooldownMs`; `models` is a required,
  nonempty array whose order defines priority.
- Models use the existing `providerID/modelID` string syntax or
  `{ id, variant?, cooldownMs? }`. The first `/` separates provider from model,
  preserving nested model IDs. Unknown fields and duplicate provider/model
  pairs are rejected, even if variants differ. Different modules may list the
  same model; native plan syntax and variant rules are unchanged.
- Each model's resolved duration is entry `cooldownMs` -> module `cooldownMs` ->
  `providerCooldownMs` (default 300000 ms). All durations must be positive safe
  integers. A cooldown means time **out of rotation**, not transport timeout.
  Request deadlines and cancellation belong to the consumer.
- Missing or empty `modules` leaves native behavior unchanged. Declared models
  form only that module's candidate list and may be absent from the chat
  catalog. Parsing never expands native registry eligibility or verifies
  provider credentials, health, quota, serving capability or permission to pay.
  Consumers must validate selected models against their own trusted allowlists;
  a module name is not authenticated caller identity or spending authorization.

**Implementation status:** Profile validation, project/module-scoped persisted
cooldowns and ordered recommendation runtime are implemented. When profiles are
configured, `quartermaster.status({})` adds a `modules` map keyed by
module name. Its entries are fresh recommendations, not evidence of inference.
Modules-only setup does not require native plans, agent bindings, chat catalog
membership or session hooks. With no profiles, the status response is unchanged.

`selectModule` and `reportModuleCooldown` are part of API version 1. Configuration
alone starts no cooldown. The native `select({ agent, workType? })`, `reportFailure`
and `reportSuccess` APIs do not operate on these profiles. Do not bind a runtime
reviewer agent in Quartermaster to reach a direct-call model. Quartermaster does
not call Jev or any other provider for a module, and it does not decide allow,
deny or escalate. Configured cooldowns are not authoritative provider quota
resets or automatic `Retry-After` discovery. A missing, malformed or rejected
result is not a candidate: do not substitute a locally configured model after
Quartermaster declines.

### Module RPC and bounded consumer helpers

The existing `quartermaster` service adds two version-1 methods. Inputs reject
extra fields, blank identities and unsupported reasons; no native registry lookup
is required. Existing native methods and their registry checks are unchanged.

| Method | Exact input | Versioned result |
|---|---|---|
| `selectModule` | `{ module: string }` | `{ apiVersion: 1, module, evaluatedAt, candidates, status, selected?, nextEligibleAt? }` with the recommendation semantics below |
| `reportModuleCooldown` | `{ module: string, providerID: string, modelID: string, reason: "rate-limit" \| "temporary-unavailable" }` | `{ apiVersion: 1, accepted: true, module, providerID, modelID, blockedUntil }`, or `{ apiVersion: 1, accepted: false, reason: "unknown-module" \| "unknown-model" }` |

Reports require an exact configured model. Durations come only from configuration;
never send raw errors, credentials, evidence or caller-supplied timeouts. Reports
acknowledge successful serialized persistence. Failed/cancelled/timed-out reports
may already have blocked a model; an ambiguous response is not retry permission.

```ts
import { requestModuleSelection, reportModuleCooldown } from "opencode-quartermaster/rpc"

const first = await requestModuleSelection(ctx, { module: "my-plugin" }, 2_000, signal)
if (first.status !== "selected") return // fail closed; do not invent a candidate
// Consumer checks its allowlist/paid policy, calls its own transport, then only
// on a structured rate limit (not a valid deny or arbitrary error):
const ack = await reportModuleCooldown(ctx, {
  module: first.module, providerID: first.selected.providerID,
  modelID: first.selected.modelID, reason: "rate-limit",
}, 2_000, signal)
if (!ack.accepted) return
const next = await requestModuleSelection(ctx, { module: first.module }, 2_000, signal)
// At most one retry: require a selected, distinct, permitted provider/model,
// reusing the original total deadline and abort signal. Never retry a valid deny.
```

Pass only providerID/modelID in reports (omit `variant` if selection contains it).
Helpers default to 2 seconds, propagate optional caller cancellation and abort
their RPC on timeout. They validate version, scope, model identity and cooldown
metadata; malformed/missing-service responses become `status: "unavailable"`.
Reporting helper failures also have `accepted: false`. Neither helper performs
inference or loops. This consumer-owned bounded retry is separate from native
one-time assignment selection and OpenCode's session retry hook.

Module names are self-reported namespaces, not authenticated security principals.
Host RPC authorization must restrict callers; namespaces prevent accidental state
bleed, not impersonation. Consumers own trust, spending policy and decision safety.
Quartermaster never receives review evidence or decides allow/deny/escalate.

### Permission-reviewer example

This is one consumer of the general contract, not a Jev client inside
Quartermaster and not certification of live serving. The profile name is
`opr-jev`. Quartermaster recommends from that profile and stores cooldowns. The
permission-reviewer plugin decides allow or deny and owns the Jev call.

Routing stays off unless trusted global `permission-reviewer.jsonc` sets
`moduleRouting.enabled` to true. Project OpenCode config, prompts, commands and
repository evidence cannot enable the route or permit a paid model. The plugin
calls `selectModule` before it builds its direct transport. It uses the
recommendation only when the model is on its allowlist and is a supported
variant-free Jev model. A paid model also requires the plugin's `allowPaid: true`.

A valid allow or deny finishes the loop. A deny is not retried. The only retry
is one structured HTTP 429: the plugin waits for an accepted `rate-limit` report
for that exact provider and model, asks again, and may call one different
permitted model. Quartermaster chooses the cooldown length from the `opr-jev`
profile: the model's `cooldownMs`, otherwise the module `cooldownMs`, otherwise
`providerCooldownMs`. The plugin does not send a duration. That cooldown is time
out of rotation. It is not the review deadline and not a discovered `Retry-After`
or quota window.

The plugin owns the review deadline and the helpers' default two-second RPC
budget. Both calls share the original deadline and the original review evidence.
Missing, malformed or rejected Quartermaster results fail closed. The plugin
does not fall back to the configured free model. OpenCode V1 has no Quartermaster
RPC client, so enabling the route there also fails closed.

Mocked permission-reviewer tests and Quartermaster's in-repo fake consumer do
not prove a live Quartermaster process or a real Jev provider. Installing this
package does not build or activate the reviewer plugin. Publishing, service
restarts and paid live validation remain separate actions.

### Live options and cooldown retention

Module queries (including status) and internal reports reread effective options
through the same receiving-server provenance and precedence rules as the project
writer. Profiles may be added after an empty startup. Invalid configuration fails
the operation rather than routing from guessed settings. Unreadable provenance is
not invalid configuration: the read is bounded, a failed or stalled read leaves the
last known good settings in place, and the failure is logged as
`[quartermaster] module configuration refresh failed`. When no settings are known
at all, `selectModule` fails with `reason: "provenance-unavailable"` rather than
answering `no-module`. The internal `query()` refreshes options; `select()` is
the synchronous snapshot selector used after refresh, not a public consumer API.

Reordering changes the next recommendation. Duration changes apply to subsequent
reports without shortening an active deadline. Removing a profile/model prunes
its module-only cooldowns and persists the removal before success; re-adding it
does not resurrect old deadlines, including after restart. Failed pruning rejects
the operation and is retried before later queries succeed. Native cooldowns are
untouched. No background file watcher or per-model timer is added.

`readOptions`/`applyOptions` still exchange the complete raw options object,
including `modules`. Preserve fields not being edited, as the existing editor
does. JSONC, revision checks, inherited read-only winners, containment and rollback
rules are unchanged. This does not hot-create startup-fixed services such as
usage collectors or budget gates; changing those may still require a reload.

### Recommendation semantics

Each module recommendation includes its `module`, server `evaluatedAt` timestamp
and ordered `candidates`, plus one outcome:

- `selected`: `selected` contains `providerID`, `modelID` and optional `variant`
  for the first candidate that is not cooling down and is not skipped for tracked usage.
- `no-module`: the requested profile is absent; `candidates` is empty. This is
  also returned by `selectModule`; status lists only configured profiles.
- `no-eligible`: no candidate is usable. When cooldown expiry determines the
  next opportunity, `nextEligibleAt` is the earliest active deadline.

Every candidate preserves its model reference and reports `health: "unknown"`.
Provider health is not measured. `reason` is `declared`, `cooldown`, `limited`,
or `usage-unavailable`. An active cooldown wins over usage and includes
`blockedUntil` and positive `remainingMs` from the same query time.
`nextEligibleAt` comes only from cooldown deadlines. A usage window, including
an estimated subscription reset, never creates a deadline and never clears a cooldown.

Quota uses the existing `usageSources` map. There is no second subscription list.
Providers mapped to `go`, `codex`, or `cursor` are tracked. A mapped model listed
in `quotaExemptModels` as `providerID/modelID` is exempt. Unmapped models,
including Jev while `opencode` is unmapped, stay cooldown-only with
`quota: "unknown"`. A module whose candidates are all unmapped or exempt does
not request usage. An exemption does not bypass a cooldown.

A mapped, non-exempt candidate is usable only when tracked usage is fresh and
`available` and the model is not cooling down. Its quota is then `available`.
Limited usage skips it with reason `limited` and quota `limited`. Stale, missing,
unknown, or failed usage skips it with reason `usage-unavailable` and quota
`unknown`. Later eligible candidates remain usable.

Selection reuses the ordered selector with an inventory private to the module;
it never registers direct models or alters native selection's own quota gating. State
is scoped to project/module/provider/model; variants share that model's deadline.
A free-model report cannot block its paid sibling or another module. Queries
make no provider calls, probes, reservations or sticky assignments. Deadlines are
checked on queries, with no per-model background timers: after free Jev cools
down, paid Jev may be recommended; once free Jev's deadline expires, free wins
again. Neither outcome proves the provider served a request or reset its quota.

## Plugin recommendations

Module selection and named-plan selection are the two plugin recommendation
paths. Agent selection remains the bound form of the plan path. None of these
calls switches the caller's session, changes a pin, reserves an exclusive
model, or starts inference. The caller applies a selected provider, model,
and optional variant itself. An availability change can schedule the same
agent-catalog reload as the periodic refresh; that reload does not switch an
active session.

- `selectModule({ module })`, through `requestModuleSelection`, reads
  `modules.<name>.models`. Mapped Codex, Cursor, and Go candidates also need
  available usage, as described above. Jev-only profiles stay cooldown-only.
- `select({ agent, workType? })`, through `requestSelection`, still resolves an
  agent binding, work type, and that agent's pin.
- `selectPlan({ plan })`, through `requestPlanSelection`, evaluates a named plan
  in plan order. It adopts current project options and refreshes the enabled
  model list and cached usage before choosing, so a process that started while
  the model was disabled or quota was limited does not keep using that startup
  snapshot. An active cooldown or exclusive hold still wins. It does not require
  an agent binding or a session, and it does not borrow another agent's pin.
  Unknown plans return `no-plan` with `unknown-plan`. Exhausted plans return
  `no-eligible` and the skip reasons.

```ts
import { requestPlanSelection, requestSelection } from "opencode-quartermaster/rpc"

const planPick = await requestPlanSelection(ctx, { plan: "review" })
if (planPick.status === "selected") {
  // The caller applies the recommendation. Quartermaster does not switch models.
  await applyModel(planPick.selected.providerID, planPick.selected.modelID, planPick.selected.variant)
}

const agentPick = await requestSelection(ctx, { agent: "reviewer", workType: "review" })
if (agentPick.status === "selected") applyModel(agentPick.selected.providerID, agentPick.selected.modelID, agentPick.selected.variant)
```

`requestPlanSelection` accepts only `{ plan }`, a nonempty name of at most 256
characters. It bounds the call, defaults to two seconds, and returns
`status: "unavailable"` for invalid input, timeout, a missing service, or a
malformed response. A selected response includes `apiVersion: 1`, the model
reference, `plan: { id, source: "named-plan", reasonCode }`, and skip reasons.
The caller checks its own allowlist before applying the model.

## Configuration editing capability

The exported `QUARTERMASTER_RPC` descriptor includes project-options reads and
writes. Both methods use the directory bound when Quartermaster registers the
RPC. Inputs do not accept a path, directory, or project ID; responses return
options and a revision, not filesystem or backup paths.

| Method | Success response |
| --- | --- |
| `readOptions({})` | `apiVersion: 1`, `status: "ok"`, effective `options`, opaque numeric `revision`, `writable` |
| `applyOptions({ options, revision })` | `apiVersion: 1`, `status: "saved"`, persisted `options`, updated numeric `revision` |

Read before editing and pass the returned revision unchanged. `options` is the
complete replacement Quartermaster options object, not a partial patch. Preserve
settings the editor does not change. Authorized V2 plugin callers use
`ctx.rpc(QUARTERMASTER_RPC)` for both methods.

When receiving-server provenance is available, the reader consumes OpenCode's
ordered `GET /api/config` documents, from lowest to highest priority. The last
matching registration wins. Its sibling `quartermaster.jsonc` is the complete
settings object and replaces any lower-priority settings as a whole. Matches in
different documents are normal overrides. Multiple matching entries in one
document fail closed. A match is the package name
`opencode-quartermaster` with an optional `@version` (legacy `quartermaster` entries
are still recognized for existing configs, not a recommendation to install that npm name), `github:SypherXN/quartermaster`
with an optional `#ref` or `.git` suffix, that same repository as an
`https://github.com/` or `git+https://github.com/` URL, or a `file:`, relative,
or absolute path that resolves to this install. Another name or path is left
unchanged, including one that only contains that word. An effective global,
ancestor or pathless inline declaration is readable with `writable: false` and
revision zero, but cannot be edited through the project writer. A pathless
winner has no sibling file, so its settings are empty. Only a winning
registration whose OpenCode config is contained in the bound project directory
is writable, including when `quartermaster.jsonc` is still missing. The editor
does not insert plugin registrations.

The writer validates settings, checks an opaque revision of the project root,
settings path and settings text, and rewrites the whole settings file as pretty
JSON plus a newline. It leaves the registering OpenCode config bytes unchanged,
including comments and unrelated plugins. When the settings file already exists,
it is copied to `quartermaster.jsonc.quartermaster.bak` before replacement. Pass
the revision unchanged; it is not a timestamp. Comments and trailing commas in
the settings file are accepted on read and are not preserved on write.

At plugin startup, Quartermaster parses an empty settings object, rejects
non-empty `plugins[].options`, then adopts the winning `quartermaster.jsonc`.
Adoption failure leaves those empty settings in place. This is complete settings
replacement, not a key-by-key merge. Invalid configuration, no matching
declaration, or ambiguous entries in one document also leave startup settings
empty. A different project may resolve a different file.

The gateway uses its existing authenticated connection and validates its fixed
directory before requesting native configuration sources. In the plugin, normal
SDK service discovery never starts a server. `Service.discover()` returns only
the registered background service. When that process is not the receiving
server, the reader uses this process's loopback `--hostname` and `--port`,
authenticating with the discovered basic credentials or the receiving process's
server password. `/api/info` must still identify this process's PID before
configuration is read. A different PID or a non-loopback address is not
provenance. `serve --stdio` deletes `OPENCODE_SERVER_PASSWORD` and
`OPENCODE_PASSWORD` before plugins load, so that loopback read cannot
authenticate. Adoption then reads the local documents this process would have
loaded: the user config directory (`OPENCODE_CONFIG_DIR`, otherwise the XDG
config directory's `opencode` folder), then each ancestor from the filesystem
root through the project, then `OPENCODE_CONFIG` when it is set. Project files
are skipped when project config is disabled. The last matching registration
still wins, and its sibling `quartermaster.jsonc` is adopted. No substitute
server is started. Editing stays unavailable without verified loopback
provenance. These paths have disposable-file and authenticated loopback tests,
not a new live-host certification. The project root and existing
configuration paths are filesystem-resolved before reading. Config and backup targets must remain inside that resolved root;
escaping junctions/symlinks and unresolvable file links fail closed. Contained
links are allowed, but multiply hard-linked files are rejected because their
other paths cannot be confined by `realpath`. Apply rechecks containment before
backup, write and rollback.
These checks do not provide atomic protection against an external process
changing filesystem links between a check and the following I/O operation.

Applies hold a project-local `.quartermaster-options.lock` directory from entry
discovery through revision checking, backup, writing and rollback. A competing
Quartermaster apply, including one from another process, fails without writing;
reload before retrying. The lock is released on normal success or failure. A
crashed process can leave it behind: stop all project writers before manually
removing that empty directory. The lock is never automatically stolen and does
not coordinate external editors that do not use the Quartermaster writer.

Both methods declare `invalid_input` and `unavailable` errors. Without a bound
directory they return `unavailable` with reason `no-project`. A failed read uses
`unavailable` with reason `read-failed`. A stale apply uses `unavailable` with
reason `stale-revision`; reload before trying again. Invalid input, invalid
options, or another apply failure uses `invalid_input`. Errors are sanitized,
not detailed filesystem or validation diagnostics.

Call options may include an AbortSignal as the second argument. The apply handler
passes the RPC signal to the writer. Cancellation observed before or during the
write rejects the update and attempts to restore the original text after a write
failure. Cancellation after a completed write does not undo the saved options.
The plugin rereads project options before prompt-time assignment and selection
operations; saving does not change an active session model. Pins are revalidated
after project-option adoption and provider-registry refresh. This is not a full
runtime reload: budget/report dependencies, exclusive-model hooks and startup
registration decisions retain their initial values. Local health settings and
cooldown duration refresh during option adoption, but structural changes can
still require a plugin restart. Binding changes take effect at the next
prompt-time assignment when the required hooks are already registered, not in
an active turn.

RPC calls do not carry an authenticated caller identity. Directory binding and a
supplied project ID are not write authorization; the calling host must authorize
access. OpenChamber uses a separate `quartermaster-options` capability for both
options reads and applies. Its `quartermaster` grant remains read-only. The host
checks the grant and enabled state, chooses the active directory, authenticates
the RPC, and cancels stale requests without giving the guest an endpoint or
credentials. The opted-in local gateway uses the same project-options reader
for its fixed directory. Its apply route saves a winning file inside the project
through the project writer, and a winning sibling outside the project through a
gateway-only writer with the same revision, backup, and basename checks. The
plugin RPC writer still refuses that outside file. A pathless winner is not
created. The outside-file lock sits beside that settings file, not in the
project. The offline draft at
[`web/README.md`](../web/README.md) stays syntax-only.

## Browser UI serving and authentication

The OpenCode V2 2.0.23 plugin surface used by this project does not provide this server plugin a web UI/router/static-asset mount; `app` is metadata, and the CLI/TUI router is not a server web mount. CORS is not authentication. Quartermaster does not claim an authenticated OpenCode UI mount or browser-safe active-project session.

Loading a checkout starts the loopback gateway on `127.0.0.1` port `4175`
(`QUARTERMASTER_LOCAL_UI_PORT`). A port that is already accepting connections
is left running. The process a checkout load starts stops when that host exits. That start does not open a browser and does not start an
OpenCode server. `QUARTERMASTER_LOCAL_UI=0` skips it. An installed archive has
no page to serve, so it does not start the gateway. `npm run local-ui` can
start the same gateway manually. It binds to IPv4 loopback, keeps credentials
server-side, uses Basic local-service auth, fixes the directory at startup and
checks report ownership. Its routes load
reports and read/apply project options; it is not a general proxy. Local processes
can access the listener, including its writer. Stop a manual gateway when finished and treat
telemetry as sensitive. It does not follow host project switches. See
[`web/README.md`](../web/README.md).

The optional [OpenChamber bridge](OPENCHAMBER_BRIDGE.md) is a separate integration,
not supplied by this gateway or required for native routing.

## Results and fallback

`requestSelection` has a 2-second default timeout, passes an abort signal to
the host RPC, validates the response, and returns `unavailable` on timeout,
RPC error, unsupported API version, or invalid response (including a malformed
optional variant). The current supported selection API is version 1. Branch
on `status`:

- `selected`: use `selected.providerID`, `selected.modelID`, and its optional
  `variant`, subject to the consumer's own model and override checks.
- `no-plan`: no route is configured for this agent; keep the existing model.
- `no-eligible`: the plan has no currently usable candidate; keep the existing
  model.
- `unavailable`: Quartermaster could not answer; keep the existing model.

Treat every non-`selected` result as a normal fallback, not an exception. Make
at most one request for an assignment; do not retry from the transform or
create a model-switch loop. Use `apiVersion` for protocol compatibility and
`reasonCode` for diagnostics; do not parse the human-readable `reason` string.

## Routing and precedence

- Send the registered agent ID. If a work type is known, pass it explicitly;
  otherwise omit it and Quartermaster uses the agent binding. It does not infer
  work from prompts. An unknown work type falls back to the agent binding.
- The public selection input is `{ agent, workType? }`; it does not accept an
  explicit model override. The consumer must preserve its own explicit choices.
- Quartermaster checks its own registered/eligible models and tries plan
  candidates in order. A manual pin is considered before plan candidates, but
  still has to be registered and eligible.
- The consumer remains authoritative: preserve explicit host/user model
  choices and active scalar presets. For candidate chains, apply the result
  only when `providerID/modelID` belongs to that chain. An explicit consumer
  variant wins; otherwise prefer that chain entry's variant, then the returned
  Quartermaster variant.

## Native same-prompt retry fallback

The isolated retry matrix below is historical OpenCode **2.0.24** evidence,
not certification of a new archive. The package pins `@opencode/plugin`
**2.0.23**; that dependency version is not the server version. See the exact
installed artifact and tested hosts in the [deployment record](DEPLOYMENT.md).
To reproduce this matrix, build the checkout and run
`node scripts/verify-retry-host-contract.mjs` with an installed **2.0.31** binary.
The script rejects other versions and contacts only its loopback fake provider.
Rate-limit is the default; `--failure=internal` and `--failure=transport` prove
additional safe failures reach the backup in the original prompt. Auth, quota,
missing-model, and context-overflow modes prove no model switch (the host may
retry the same model). `--exhausted` verifies two primary requests followed by
ten fallback requests before host failure. The fixture checks bounded attempts,
the original prompt, and zero tool calls. The host owns retry approval, delay,
and its attempt ceiling. Quartermaster never changes `decision.retry` or delay;
it switches only for a host-approved retry with an explicitly safe structured
failure correlated to a bound agent's primary request, and excludes attempted
models from the remaining plan.

Routing classification uses the structured type/status fields and, for rate
limits only, a narrow text check over `error.message` and `error.response.body`
that mirrors the host's own plain-text retry rule; it persists no raw errors.
Rate limits (429, `provider.rate-limit`, or that text) create a model-scoped
temporary cooldown. Confirmed quota errors (`provider.quota` or 402) also
create a model-scoped cooldown, and OpenCode Zen reports its shared free-tier
bucket that way. Models listed together in `sharedRateLimits` copy either
cooldown to every member, so the next selection skips the whole shared bucket.
Model outages, provider outages, and success do not spread across the group.
Groups are disjoint, contain at least two `providerID/modelID` strings, and
are reread when project options are adopted.

A provider may also state when its limit resets. The host's `http.response`
hook exposes the response headers of requests that were already sent, so
Quartermaster reads `retry-after` and `x-ratelimit-reset*` from those
responses. A stated reset time extends the cooldown the failure applies;
`providerCooldownMs` remains the floor, so a stated reset can make a cooldown
longer but never shorter. Only a rate-limit or quota response states when the
limit frees, so a later success never shortens a cooldown by itself. The
read costs no request and no tokens, and Quartermaster never sends a probe
request to ask whether a model is still rate limited: a probe against an
exhausted shared bucket spends that bucket's own request quota. The observed
state is reported read-only as `providerRateLimits` in the session
diagnostics, with the stated reset, remaining quota, limit and source header.
Retry-approved internal/transport and 408,
409, or 5xx outage signals may switch to an eligible backup. Confirmed quota
errors (402 or `provider.quota`) create a model-scoped cooldown for subsequent
assignments, but do not trigger immediate retry fallback. Auth and permission
errors neither create cooldowns nor switch models.
Missing-model/no-route errors may cool down that model for later assignments
but remain terminal in the current execution. Context overflow, content
filtering, unsupported operations, invalid output, timeouts, and unknown errors
remain terminal for Quartermaster selection; the host may still retry the same
model under its own policy. Cooldowns affect subsequent selection, including
safe retry selection and later prompt admission. Correlated terminal
`session.execution.failed` events also record failures without approving a
retry or resending the turn. Their original event timestamp determines expiry;
invalid or future timestamps are ignored. Persisted unexpired cooldowns survive
restart, but errors never observed by this plugin cannot be recovered from a
failed session outcome alone. Quota mode also verifies a new explicit prompt
uses fallback after restarting the isolated fixture with retained storage.
`diagnoseSession` exposes active `failureCooldowns` with provider/model,
classification, `occurredAt` and `until` when that evidence is available.
For terminal events, `occurredAt` is the host event timestamp; for retry hooks
(which provide no occurrence timestamp), it is the local observation time.
Legacy restored cooldowns may lack that metadata. Reobserving a terminal event
does not extend its original deadline.

Compaction has its own durable `session.compaction.failed` event. On the tested
2.0.31 host a failed compaction can leave the execution outcome **succeeded**;
the outcome alone is not recovery evidence. Quartermaster observes this event
without releasing primary exclusive leases or replacing primary retry state.
Bound automatic requests retain model/variant and ownership evidence for up to
15 minutes (512 requests maximum), including after execution cleanup. Late
failures cool the original model, not the currently selected model or agent.
Conflicting overlapping evidence, invalid/future timestamps, expired cooldowns
and unmanaged requests are ignored. Equivalent overlapping model/ownership
evidence suffices only for model cooldown attribution, not request identity.
Capacity overflow conservatively suspends attribution for the retention window.
Duplicate failure timestamps do not recreate a cooldown cleared by success.

Request hooks and retry payloads supply no stable request ID; retries also omit
request kind. An auxiliary request following a primary suppresses immediate
retry switching until another primary request is observed. Arbitrarily reordered
retry callbacks cannot be fully attributed with this host contract. Dedicated
terminal events remain the recovery evidence; no log/database reconstruction or
turn replay is attempted. Request correlation is not restored across restart,
but successfully persisted cooldowns are. A separately configured compaction
model is cooled independently; changing the primary model does not prove that
compaction recovered. Same-turn compaction model replacement is unsupported.

`diagnoseSession.lastFailureObservation` provides bounded, sanitized request kind,
model-level attribution, durable occurrence time, observation time, deadline
and outcome; it contains no prompt, summary or raw error. Cooldown memory is
updated before asynchronous persistence, so admissions after observation see it;
already-dispatched work is never replayed. Use
`node scripts/verify-retry-host-contract.mjs --compaction --failure=quota` for
actual next-prompt fallback and retained-storage restart proof, or
`--compaction --failure=rate-limit` for captured-model 429 retries followed by
next-prompt recovery. Text-only compaction classification and reordered delivery
are covered by synthetic regressions, not claimed as real-host reproductions.
Live activation and historical attribution of the reported incident remain
unverified; these checks contact only the loopback fixture.

`node scripts/verify-retry-host-contract.mjs --compaction --failure=quota --probe-compaction-selection`
is an isolated selection-boundary probe, **not a production recovery feature**.
On 2.0.31 it switches the session model inside the compaction hook and proves
the current compact still dispatches the captured primary model. A second
explicit compact, with no intervening prompt, dispatches fallback and completes
native summary validation, but the session's primary model is also permanently
changed. The user approved this primary-selection side effect for managed recovery. The installed
hooks expose read-only request models; compaction-only selection needs a
supported host boundary rather than an assumed effect of `switchModel`.

After recording a fresh attributed compaction cooldown, QM now selects the next
eligible primary model using the existing automatic assignment path. It waits
for an observed active primary to finish, and only switches if the agent and
primary model still match the failed compaction request. Current manual/unbound
ownership and later user model changes are respected. A dedicated compaction
model is not silently replaced. No failed compact is replayed: request compact
again after selection finishes.

`node scripts/verify-retry-host-contract.mjs --compaction --failure=quota --recover-compaction`
proves production recovery without the observer's switch: the second compact
dispatches fallback and completes native summary validation without a prompt.
The same check passes with `--failure=rate-limit`. Same-attempt replacement,
an independent dedicated compaction-model fallback, and an atomic admission hook
for concurrent compacts remain unsupported. A compact already captured during
asynchronous failure handling may still use the old model. Auto-compaction and
restart directly into a compact have not been proven by this fixture (its
retained-storage restart checks a subsequent ordinary prompt).

Quartermaster excludes already
attempted provider/model IDs when choosing another backup; it does not prevent
OpenCode from retrying the current model or reset the native attempt limit.

Only clean pre-output retries are fallback evidence. Partial-output continuation
is separate: Quartermaster does not roll back output or switch mid-response.
The managed 2.0.26 proof verifies an automatic same-model continuation after one
completed read, without replaying that tool. This is a tested scenario, not a
universal exactly-once guarantee. Other plugins can hook retry: Quartermaster observes the
decision when its hook runs and never overrides a veto, but cross-plugin hook
ordering or later decision changes are not covered. See the isolated
[`qm-test` procedure](../examples/test-agent/README.md) for optional provider
smoke guidance and safety boundaries.

## Opt-in recovery probes

`probeRateLimits` is an opt-in list of fully qualified model IDs
(`providerID/modelID`, optional `variant`), `probeIntervalMs` is the base
interval in milliseconds (default 300000) and `probeMaxBackoffMs` is the
longest backoff between two probes of one bucket in milliseconds (default
3600000). The feature is off by default: with
no list, no provider is ever asked whether it is still rate limited, and the
behaviour described above is unchanged.

A probe is a separate one-shot generation issued by the host through the
plugin's session-free `generate.text` API. It never replays, resends or
re-issues a user turn, creates no session, and is not routed or retried by
Quartermaster. It is sent by the host because the OpenCode Zen free tier
rejects callers outside OpenCode (`FreeTierError`); a plugin-side HTTP call
would not be accepted. A probe spends one real provider request slot from the
shared bucket and a tiny completion, so it costs a small amount of money on a
paid provider: the explicit list is the safeguard, and the feature is meant
for free tiers.

The host contract for that call is verified in the OpenCode source and end to
end by `scripts/verify-probe-host-contract.mjs`, which runs a real host against
a loopback provider: the session-free `generate.text` route is `POST /api/experimental/generate` with a
`{ prompt, model }` payload and no session id. The host creates no session and
stores no chat for it — it attributes the request with a fresh, never
registered id in the `x-opencode-session` header, which is the only trace and
disappears with the request. Nothing is created, so nothing has to be removed
afterwards, and no session event is emitted. The host also fires no session
hook for a session-free generation, so the `model.request`, `retry` and
`http.response` hooks never see a probe: Quartermaster cannot route it,
cannot retry it and does not read headers from it.

One probe is not always one provider request. The host applies its own retry
policy to the failed generation, so the shape of the answer decides the cost.
Verified against a real 2.0.31 host and a loopback provider reproducing the
OpenCode Zen free-tier 429 body (`{"type":"rate_limit_error", ...}`, no limit
headers): the host made exactly one provider request and failed fast without
retrying. A 429 that carries the limit state instead (`retry-after`,
`x-ratelimit-remaining-requests: 0`) is a retryable rate limit for the host and
is retried on its own delay, so that shape can cost several request slots of the
bucket. Raise `probeIntervalMs` for a provider that answers that way.

A model is probed only when all of the following hold: it is listed in
`probeRateLimits`; it is rate limited or a member of a `sharedRateLimits`
group whose bucket is exhausted; the bucket's first probe waited for its own
cooldown floor to expire, so a probe never runs while the model is still
known-limited and never extends a known penalty window; no provider-stated
reset is pending, because that time already says when the limit clears; the
backoff window since the last probe of that bucket has elapsed (the interval
doubles per failed probe and is capped at `probeMaxBackoffMs`, default 60
minutes); no primary request is
running, so a probe never adds load next to real work; and at most one probe is
sent per shared bucket per cycle. The probe interval is the poll cadence, not
the skip window: after the first probe of a bucket the backoff alone drives the
schedule, so a provider floor never swallows the backoff and polling keeps
running.

With the default interval of 5 minutes and the default cap of 60 minutes, the
gaps between probes of a bucket that stays limited are 10, 20, 40 and then 60
minutes, and 60 minutes after that. The long cap is deliberate: a shared
free-tier bucket can stay capped for hours, and a 15 minute heartbeat would
spend a lot of requests against it. The trade-off is honest: a longer cap means
the recovery of a bucket can go unnoticed for up to the cap, so lower
`probeMaxBackoffMs` if you want the model back sooner.

Outcomes: a resolved generation means the model recovered, so the cooldown of
that model and of every member of its shared group is cleared; a rate-limit or
quota error (402, 429, `provider.quota`, `provider.rate-limit`, or the plain
rate-limit text the host itself retries on) means the bucket is still limited,
and that is recorded only: a probe measures a bucket instead of being a user
request, so it never extends a cooldown and never re-cools the shared group.
Only a failed request may create or extend a cooldown, which keeps a model out
once per incident instead of once per probe. Any other failure (auth,
network, unknown) changes nothing and is only recorded. A recovered bucket
leaves an unrelated outage cooldown of a group member alone: that model did
not recover, only the bucket did. Both Zen free-tier shapes are handled the
same way: a quota-shaped error and a retryable 429 both keep the whole shared
bucket out of rotation and both clear on a successful probe.

The probe state is reported read-only as `rateLimitProbes` in the session
diagnostics, with provider, model, outcome (`success`, `still-limited` or
`error`) and time, and no error text, prompt or response content.

Two limits are worth stating plainly. Whether the host itself retries a failed
session-free generation internally is unverified on the tested host, so one
probe may in principle consume more than one request slot; and whether
repeated probing while over the cap extends the provider's penalty window is
unverified. The opt-in list, the doubling backoff with its 15 minute cap and
the conservative default interval are the protection in both cases.

## Optional RPC methods

Use the same exported `QUARTERMASTER_RPC` descriptor for other supported
operations:

- `explain({ agent })` explains a routing decision; reserve it for diagnostics
  or an explicit request. Current RPC schemas do not accept `sessionID` for
  `select` or `explain`, even though internal handlers can use it. As a result,
  RPC callers cannot request owner-aware exclusive-model availability; omitted
  session identity treats an occupied model as busy.
- `status({})` returns Quartermaster's current status.
- `diagnoseSession({ sessionID })` reads bounded session/runtime diagnostics and
  cached availability without changing routing or sending inference. See the
  [diagnostic guide](../README.md#diagnose-the-handling-runtime).
- `report({ since?, until?, limit?, offset?, refresh?, projectID? })` reads the
  active project's bounded telemetry summary; `projectID` must match the active
  project and is otherwise refused. `requestReport` adds timeout/response
  validation. Plugin attribution uses the separate `reportPluginUsage` method.
  A call that never became a host step, such as a direct Jev request, is
  submitted with `reportDirectUsage({ pluginID, pluginName, usageID, providerID,
  modelID, variant?, counts })`. `counts` requires `input` and `output`;
  reasoning and cache counts are optional. The same `usageID` replaces that
  plugin's earlier row. Those counts stay in `report.directUsage` and are not
  added to host totals or budgets. See
  [telemetry contracts and limits](TOKEN_TELEMETRY.md).
- `pin({ agent, model })` and `unpin({ agent })` manage a manual agent
  preference. Call these only for an explicit user action; pins remain subject
  to model registration and current eligibility.
- `reportFailure({ providerID, classification, modelID? })` and
  `reportSuccess({ providerID, scope, modelID? })` report observed request
  outcomes and update runtime eligibility. Only report outcomes from provider
  requests your plugin owns. A model-outage failure or model-scoped success
  requires `modelID`.

Failure classifications are `provider-outage`, `model-outage`,
`temporary-rate-limit`, `quota-exhausted`, `auth`, `cancelled`, and `other`.
These feedback methods are not a token-usage or arbitrary telemetry upload
API. Handle their errors without blocking the user's task, and do not resubmit
the same outcome in a retry loop.
