# Quartermaster

OpenCode V2 plugin that assigns agent models from named plans and provider availability.

A **plan** is an ordered list of models: Quartermaster uses the first eligible
candidate and returns to higher-priority candidates when they recover. Bind a
plan to an existing agent to enable automatic routing. Unbound agents keep their
host-selected models.

## Install

Requires Node.js 23.6 or newer. The package is `opencode-quartermaster@0.1.0`;
the plugin and RPC ID are `quartermaster`. It is **not published to npm**.
`private: true` blocks publication, but local archives can be built and installed.
Do not install the unrelated npm package named `quartermaster`.

Build and verify an archive from a checkout:

```sh
npm ci
npm run verify-package
```

This prints an archive/hash and clean-install evidence in owned temporary storage without overwriting checkout `dist` or earlier archives. It checks imports/types and installed-copy standalone loopback admission. Public dependencies may be downloaded; inference stays on loopback. Standalone proof alone does not certify OpenChamber. See [clean installation and the release gate](docs/DEPLOYMENT.md).

Copy the archive to the destination machine and install it locally:

```sh
npm install --prefix .quartermaster --ignore-scripts --no-audit --no-fund /path/to/opencode-quartermaster-0.1.0.tgz
```

Add exactly one plugin entry to the destination project's OpenCode config, and put Quartermaster settings in `quartermaster.jsonc` beside that file:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "agents": {
    "reviewer": { "mode": "all", "model": "provider-a/quality-model" }
  },
  "plugins": [
    {
      "package": "./.quartermaster/node_modules/opencode-quartermaster"
    }
  ]
}
```

Settings beside that file:

```jsonc
{
  "plans": { "review": ["provider-a/quality-model", "provider-b/backup-model"] },
  "agents": { "reviewer": "review" }
}
```

This registration belongs in a project-root `opencode.json(c)`. Merge it into an
existing config rather than replacing that file. Model IDs are placeholders:
replace them with enabled `providerID/modelID` values from the receiving host's
`opencode models` output. A binding does not create an agent; the example defines
`reviewer` explicitly. A missing `quartermaster.jsonc` means no settings. Do not
also put settings in `plugins[].options`: a non-empty options object is rejected,
while an omitted or empty options object is valid.
[`examples/quartermaster.json`](examples/quartermaster.json) contains settings
alone, not a full OpenCode config. For other config locations, see
[registration scope](docs/DEPLOYMENT.md#registration-scope).

### Documentation guide

- [Deployment](docs/DEPLOYMENT.md): installation, updates and dated host evidence.
- [Plugin integration](docs/PLUGIN_INTEGRATION.md): native selection, direct-call modules and options RPCs.
- [Telemetry](docs/TOKEN_TELEMETRY.md) and [budgets](docs/TOKEN_BUDGETS.md):
  observed usage, unknown attribution and advisory limits.
- [Local tools](web/README.md): offline reports and opt-in configuration editing.
- [Test agents](examples/test-agent/README.md): isolated routing checks.

On an OpenChamber build that includes the Quartermaster panel, allow `quartermaster` to read reports and `quartermaster-options` to save. The read grant cannot save. The panel is part of OpenChamber, not this package. See [the bridge](docs/OPENCHAMBER_BRIDGE.md).

A checkout can also start the optional local page with `npm run local-ui`. See [`web/README.md`](web/README.md).

### Package policy and updates

The archive includes compiled JavaScript, type declarations, public docs and the
MIT license. It excludes source/tests, examples, the web UI and local state.
Links to examples/web refer to the repository, not archive contents. To load a
checkout directly, run `npm ci` for dependencies and register the plugin by
path: the host loads the root `index.ts`, which re-exports the TypeScript
source, so no build is needed. `npm run build` produces the `dist` files that
the packaged `index.js` main and the `./rpc` export use.

The plugin/client dependencies are pinned to 2.0.23. This is not the running
OpenCode server version. The recorded private archive passed Windows standalone
OpenCode 2.0.27, Ubuntu standalone 2.0.26, and stock OpenChamber 2.3.1 with managed
OpenCode 2.0.27. See the [exact archive and tested matrix](docs/DEPLOYMENT.md#verified-private-artifact-2026-10-13).
That historical record does not certify later source changes or untested hosts.

For updates, retain the previous archive/hash and back up the exact destination config. Install a specific replacement archive, verify its root/RPC imports and receiving-runtime diagnostics, then restart only with authorization if required. Roll back by reinstalling the retained archive and restoring the changed plugin registration and `quartermaster.jsonc` from the backup. After a separately authorized registry release, `opencode-quartermaster@<exact-version>` will be the npm entry; it is not an available install route yet. Publishing, removing the private guard, credentials, registry uploads and release tags require separate approval.

### Stock OpenChamber setup

OpenChamber uses the same native OpenCode server plugin; no panel, bridge, fork or proxy is required for routing. Define the agent in OpenCode and bind that exact agent ID under `agents` in `quartermaster.jsonc`. A plan binding does not create the agent. Check enabled model IDs in the receiving project's registry rather than assuming a provider/model name is available.

Use one Quartermaster registration per config document. The highest-priority registration wins, and its sibling `quartermaster.jsonc` replaces lower-priority settings **as a whole**, not per key; repeat all required plans, bindings and maps. A pathless registration has no sibling file, so its settings are empty. The project-options reader rejects ambiguous duplicates. Preserve unrelated host settings and back up config before an authorized edit. The options-save RPC copies an existing settings file to `quartermaster.jsonc.quartermaster.bak`, then rewrites that file. It leaves the OpenCode config unchanged. Startup-fixed changes may require an authorized receiving-server restart.

Confirm the handling process with `/qm-status` or the immediate diagnostic RPC below, then correlate its PID with host process ownership. A host name of `cli` can also describe an OpenChamber-managed child; neither that label nor matching session IDs proves which server handled the chat. An unbound `build` agent is expected to stay on its host model: select an already defined bound agent rather than adding bindings implicitly. Missing RPC/commands mean checking plugin loading and location scope before diagnosing selection.

Quota integration is optional: verify `opencode-usage.status({})` exposes `go`, `codex` or `cursor`, then deliberately map actual provider IDs through `usageSources`; absent maps report `unconfigured`, not available quota. For NInfer, verify the configured loopback GET endpoint (for example `http://127.0.0.1:8080/v1/models`) in the receiving runtime; a stopped server reports offline. Do not start inference, exhaust quotas, recover credentials or change maps merely to obtain a passing test. Jev Auto and custom reviewer generation are separate paths, not substitutes for native bound-agent admission proof.

## Development

Maintainer checks, not part of install:

```sh
npm ci
npm test
npm run typecheck
```

`npm run build` emits JavaScript and declarations into `dist`; `npm run typecheck` checks without emitting. The root `opencode.json` and `opencode-usage.json` are local state and are not part of the plugin.

## Configuration

All settings belong in `quartermaster.jsonc` next to the OpenCode config that registers the plugin:

- **Plans:** ordered `providerID/modelID` strings or
  `{ "id": "providerID/modelID", "variant": "..." }` objects. Plans must be
  non-empty with unique candidates; bindings must name an existing plan.
- **Work types:** `workTypes` maps a work-type name to an existing plan. The
  `select` RPC checks the work-type binding before the agent binding; an
  unknown alias falls back to the agent binding.
- **Quota:** `usageSources` maps provider IDs to `go`, `codex`, or `cursor`.
  Limits skip all mapped models except explicit `quotaExemptModels` (fully
  qualified IDs, all variants). Only fresh, confirmed `limited` usage skips a
  model; absent, stale, or unusable usage reads as available and stays a
  candidate. Estimated resets alone do not restore eligibility. Unmapped
  providers are unaffected by quota status.
- **Health:** `localEndpoints` opts local providers into credential-free,
  bodyless loopback HTTP(S) GET checks, cached for five seconds. Failure skips
  only that provider; remote providers are not health-probed.
- **Durations:** positive integer milliseconds. `providerCooldownMs` defaults
  to 300000; `localHealthTimeoutMs` to 2000; `probeIntervalMs` to 300000;
  `probeMaxBackoffMs` to 3600000.
- **Shared rate limits:** `sharedRateLimits` lists groups of fully qualified
  model IDs that share one limit bucket. A temporary rate limit or confirmed
  quota error on any member cools the whole group for `providerCooldownMs`.
  OpenCode Zen reports that shared free-tier bucket as quota. Outages and a
  later success stay on their own model or provider. A model can belong to
  only one group.
- **Provider-stated rate limits:** when a provider states when its limit
  resets (`retry-after`, `x-ratelimit-reset*`), that time extends the
  cooldown, and `providerCooldownMs` stays the floor: a stated reset can make
  a cooldown longer, never shorter. The hint is read from responses the host
  already received, so it costs no request and no tokens. Without
  `probeRateLimits` Quartermaster never polls a provider to ask whether it is
  still rate limited, because a probe against an exhausted bucket spends that
  bucket's request quota. The stated state is reported as `providerRateLimits`
  in the session diagnostics.
- **Recovery probes:** `probeRateLimits` lists fully qualified model IDs
  (`providerID/modelID`, optional `variant`) for which Quartermaster may
  actively check whether the limit cleared. The feature is off by default and
  the list is the safeguard: a probe spends one real provider request slot and
  a tiny completion, so enable it only where that is acceptable, such as a
  free tier. `probeIntervalMs` (default 300000) is the base interval; the
  interval doubles per failed probe and is capped at `probeMaxBackoffMs`
  (default 3600000). With the defaults the gaps between probes of a still
  limited bucket are 10, 20, 40 and then 60 minutes, and 60 minutes after
  that: a shared free-tier bucket can stay capped for hours, so the cap is
  deliberately long. The trade-off is honest: a longer cap means the recovery
  of a bucket can go unnoticed for up to the cap, so lower
  `probeMaxBackoffMs` if you want the model back sooner. It is the
  poll cadence, not the skip window: the first probe of a bucket waits for the
  model's own cooldown floor to expire, later probes follow the backoff. A
  probe is only sent when no provider reset time is pending, when no primary
  request is running, and at most once per shared bucket. A successful probe
  clears the cooldown of that model and of its shared group; a probe that is
  still limited keeps the model out for the configured `providerCooldownMs`,
  because it is fresh evidence that the model is unusable; any other failure
  changes nothing. A probe is a separate one-shot generation through the host:
  it never replays, resends or re-issues a user turn. It is sent by the host,
  because the free tier rejects callers outside OpenCode. The host creates no
  session for it and stores no chat: the call carries no session id and the
  attribution id the host sends in `x-opencode-session` is never registered, so
  there is nothing to remove afterwards. The host fires no session hook for a
  session-free generation, so Quartermaster never sees or routes a probe. A
  probe is one request: against a loopback provider reproducing the OpenCode
  Zen free-tier 429 body, a real 2.0.31 host made exactly one provider request
  and failed fast without retrying. A 429 that carries the limit state instead
  (`retry-after`, `x-ratelimit-remaining-requests: 0`) is retried by the host on
  its own delay, so that shape can spend several request slots of the bucket:
  raise `probeIntervalMs` for it. Whether repeated probing while over the cap
  extends the penalty window is unverified, so the backoff and the opt-in list
  are the protection. The probe state is reported as `rateLimitProbes` in the
  session diagnostics.
- **Exclusive models:** `exclusiveModels` lists fully qualified model IDs.
  Automatic selection skips busy models. All primary requests using a listed
  model acquire its lease, including manual/unbound requests; auxiliary
  compaction/title/generate requests are not gated. Leases belong to one plugin
  instance, not multiple projects/processes. Automatic reservations span the
  turn; abandoned leases expire after 15 minutes without renewal.

Eligibility refreshes at prompt admission, selection/explanation, and safe retry
selection—not on every dispatch. Quota reads use cached
`opencode-usage.status({})`; Quartermaster never forces provider polling, apart
from an enabled recovery probe for a listed model.

The public `select({ agent, workType? })` RPC uses a known work-type binding
before the agent binding; an unknown alias falls back to the agent binding.
Without either binding it returns `no-plan`. An eligible agent pin is considered
before the chosen plan's candidates. The RPC recommends a model; it does not
accept an explicit model override or switch a session. Quartermaster never
infers work type from prompt text.

Bound agents use Quartermaster automatic routing by default. In OpenCode's stock TUI, use `/qm-manual` before a deliberate model/variant change to leave that session's choices to the host; use `/qm-auto` to resume Quartermaster routing. Stock host hooks do not expose reliable provenance for same-model re-selection, so the default may replace an inherited or pre-first-prompt model/variant choice. The prompt hook awaits any needed model switch before admission and rejects the prompt if no eligible model can be selected or the switch fails.

Pins are validated against the agent's configured plan and enabled model registry when loaded or set. They persist under a project-scoped plugin-storage key and are revalidated after project-option adoption and registry refresh. The legacy shared key is used only when no project identity is available; its values are not imported into project namespaces. A pin changes the next selection, not an active turn. Selection explanations expose stable reason codes and per-candidate skip reasons.

An agent pin is a preference within automatic routing, not a session opt-out.
Use `/qm-manual` when the host should control the session's model instead.

### Direct-call module profiles

The optional `modules` map defines independent profiles for third-party plugins
that call models outside OpenCode's chat hooks. A module is configuration, not
executable code or a provider client. Example `quartermaster.jsonc`:

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

Each profile requires a nonempty, ordered `models` list of strings or
`{ id, variant?, cooldownMs? }` objects. Module names must be nonempty without
surrounding whitespace; provider/model candidates must be unique within a
module, even across variants. Model IDs may contain `/`.

Cooldowns are positive safe-integer milliseconds: entry `cooldownMs` overrides
module `cooldownMs`, then `providerCooldownMs` (default 300000). This is time
**out of rotation**, not an HTTP request timeout; the consumer owns its request
deadline. Omitting `modules` or using `{}` leaves native routing unchanged.
Native plan entries still accept only `id` and optional `variant`.

Only the declared models are candidates for that module. They may be absent
from the host chat registry; declaring them does not register native models,
bind agents, verify credentials/health/quota, or authorize paid use. The consumer
must enforce its own trusted configuration and model allowlist.

Profile validation, persisted module cooldowns and ordered recommendations are
implemented. With profiles configured, `quartermaster.status({})`
includes a `modules` map with current selections and cooldown reasons/deadlines.
Recommendations do not call providers. Health stays unknown. Unmapped models,
including Jev, and models listed in `quotaExemptModels` stay cooldown-only with
unknown quota. A Jev-only module does not request usage. Mapped Codex, Cursor,
and Go providers in `usageSources` also need fresh available usage; limited,
stale, missing, or failed usage skips that model. Usage recovery does not clear
a cooldown. After a cooldown expires, the earlier eligible candidate wins again.

Modules-only startup needs no native plans, agent bindings, chat catalog entry or
session hooks. Module queries/reports adopt effective options; edits retain active
deadlines, while removal durably prunes module-only state. Use `selectModule` and
`reportModuleCooldown`, or the typed `requestModuleSelection` and
`reportModuleCooldown` helpers from `opencode-quartermaster/rpc`.
Configuration alone starts no cooldown.
Existing `select`/failure-feedback RPCs remain native-routing APIs. See the
[module contract and selection semantics](docs/PLUGIN_INTEGRATION.md#direct-call-module-profiles).

The `opr-jev` profile above is an example name for one direct-call consumer. Quartermaster only recommends a configured model and stores a reported cooldown. It does not contain a Jev client. The permission-reviewer plugin owns the provider call and the allow or deny decision. That route stays off unless its trusted global `permission-reviewer.jsonc` sets `moduleRouting.enabled` to true. Project config, prompts, commands and repository evidence cannot enable it or permit a paid model. Installing Quartermaster does not build or activate that plugin. Mocked reviewer tests are not a live Quartermaster process or real Jev serving. The fail-closed sequence is in the [permission-reviewer example](docs/PLUGIN_INTEGRATION.md#permission-reviewer-example).

### Diagnose the handling runtime

Run `/qm-status` in the chat being diagnosed. It queues a JSON diagnostic with `delivery:"queue"` and `resume:false`, without waking execution or changing the model, ownership, pins, leases or configuration. On stock OpenCode 2.0.25 and 2.0.26 it stays in the pending inbox, not the visible history, until a later normal turn delivers it; it can then become model context. Immediate in-chat display without inference is not supported by this command API. For immediate output without queuing anything, call the read-only `quartermaster.diagnoseSession({ sessionID })` RPC through the actual receiving server's authenticated, project-scoped `/api/rpc/quartermaster/diagnoseSession` endpoint with `{ "input": { "sessionID": "ses_..." } }`.

Both paths report the loaded plugin version, host-reported app version, local process ID and per-load plugin-instance ID, project/location, binding/plan, automatic/manual/unbound mode, authoritative session model/variant, cached recommendation and skip reasons. Missing metadata is unknown; matching session IDs across servers is not runtime identity. A known project mismatch hides the other session's agent/model and reports `scope:"mismatch"`; missing project identity reports `scope:"unknown"`, not confirmed ownership.

Availability is the active router's cached snapshot, not a forced refresh or configuration reread. Snapshot age, refresh interval, health-cache duration and available quota timestamps are shown. Quota `unconfigured` means no source mapping; `local-offline` means a configured health probe failed; `not-in-registry` means a candidate is not enabled. Recommendations do not switch models or guarantee a send. Primary evidence is only a `model.request` hook observation since this instance loaded, not an HTTP-send/success claim; auxiliary requests are excluded. Session and ownership reads are bounded; unknown reads do not expose raw errors or credentials.

If the command is absent, inspect the actual receiving server's project-scoped
`/api/plugin` and `/api/command` through normal host authentication. Check plugin
loading, effective project options and server version; a separate CLI server is
not OpenChamber-runtime proof. Startup-fixed options may need an authorized
restart. Do not recover credentials or bypass authentication. A queued command
response is not proof that a client displayed it immediately.

## Cross-plugin API

Import the versioned RPC contract from the `opencode-quartermaster/rpc` package subpath and call it from another V2 plugin:

```ts
import { QUARTERMASTER_RPC, requestReport, requestSelection } from "opencode-quartermaster/rpc"

const selection = await requestSelection(ctx, { agent: "reviewer", workType: "review" })
// `selected`, `no-plan`, `no-eligible`, or safe `unavailable` fallback
const status = await ctx.rpc(QUARTERMASTER_RPC).status({})
const report = await requestReport(ctx, { since: Date.now() - 86_400_000, limit: 50 })
```

RPC responses carry `apiVersion: 1`; selection returns the model reference and structured selected/skipped reason codes. `requestPlanSelection(ctx, { plan })` evaluates a named plan without an agent binding or a session. `requestSelection(ctx, { agent, workType? })` still uses the agent binding, work type, and pin. Both return the provider, model, optional variant, and skip reasons. The caller applies that model itself; Quartermaster does not switch the session or start inference. The API also exposes `explain`, `pin`, `unpin`, `reportFailure`, and `reportSuccess`. Invalid inputs and unavailable routing have typed errors. Status contains sanitized usage windows and reset metadata, never upstream error text or credentials. `select` only recommends a model; it does not switch an active session model. Consumers should handle `unavailable` by keeping their host-selected model.

Direct-call modules use the same subpath. `requestModuleSelection` and `reportModuleCooldown` recommend and remember cooldowns; they do not call a provider or decide allow or deny. See the [module contract](docs/PLUGIN_INTEGRATION.md#direct-call-module-profiles).

`requestReport` reads bounded usage, budget, and observed retry-error summaries for the plugin's active project context. It never accepts caller-supplied ownership; requesting another project returns `unsupported` because this plugin API exposes no caller identity/authorization mechanism. Reports label unknown attribution and incomplete live-event coverage, and `refresh` only rereads the durable ledgers—it does not poll providers or replay events. See [telemetry reporting limits](docs/TOKEN_TELEMETRY.md).

## Native routing boundaries

Quartermaster preloads the enabled registry and availability before OpenCode's
synchronous agent transform. It edits only the model field, retaining prompts,
permissions and other settings. Registry/availability changes refresh the agent
catalog for later assignments, not an active response.

OpenCode keeps a session's selected model separate from its agent. At an idle prompt boundary, Quartermaster selects from a bound agent's current plan, awaits `switchModel` if needed, and confirms the authoritative selection before admission. An out-of-plan default or changed model/variant does not imply a manual opt-out. `/qm-manual` preserves host choices at admission and retry selection until `/qm-auto` resumes; the opt-out is scoped to the stored project/session/agent and survives plugin reload. Agent changes and session deletion clear old ownership. Failed ownership reads, no eligible model or an unconfirmed switch reject automatic admission and release reservations.

Quartermaster does not switch an active primary response for queued/steered input or spend inference to choose a route. Automatically owned bound primary requests now recheck ownership, plan membership and availability in `model.request`, before acquiring an exclusive request lease or sending. A stale/ineligible captured model is rejected and its reservation released; no model or HTTP request is rewritten. Manual opt-outs, unbound agents and auxiliary requests bypass this safety guard. Health uses the existing five-second cache and usage remains cached, so this is not continuous availability monitoring. Execution-boundary reselection remains unsupported on stock OpenCode 2.0.26: after rejection, send again when idle to select a fallback. The prompt hook runs at enqueue; execution hooks cannot replace the captured model. Configured subagents receive the agent transform, but direct generation/custom reviewer paths are not automatically covered by an agent name. Transforms replay in registration order: later transforms may override Quartermaster. Load it after model transforms it should take precedence over.

Safe, correlated primary failures can select a remaining eligible backup during a host-approved native retry and create a scoped outage/rate-limit cooldown. Quartermaster does not create another retry loop or change the host's retry approval/delay. Auth, confirmed quota, cancellation and generic errors do not create outage cooldowns or select a backup. Other owned outcomes can use the reportFailure/reportSuccess RPCs. Cooldowns persist; recovery affects a later automatic admission, never an idle session or active response. Availability refresh reads cached usage and configured loopback health, not provider APIs.

### Managed-host verification limits

The [2026-10-13 deployment record](docs/DEPLOYMENT.md#verified-private-artifact-2026-10-13)
identifies the exact private archive, tested hosts, provider-request traces,
desktop/mobile-emulated UI, keyboard and cleanup checks. It is historical
evidence, not certification of the current checkout or every host version.

**Queued-input limitation:** stock OpenCode 2.0.26 does not support transparent
reselection when queued input begins execution. It can retain a still-eligible
captured model; an ineligible automatic selection is rejected before sending
and must be resent when idle. Queue safety is not queue reselection.

Earlier managed-host checks on 2.0.26 covered automatic routing, manual
opt-out/resume, native children and rejected admission. Switch-failure cleanup
used an injected client exception, not a naturally occurring host rejection.

The recorded lifecycle checks cover persistent manual choices, child idle turns,
cancellation, reload/deletion and independent project/plugin instances. They do
not establish cross-instance lease coordination or live quota-driven recovery.
Fixtures use unique provider IDs rather than clearing production cooldowns.

With explicit authorization and `OPENCODE_PERMISSION_REVIEWER_HOST_URL` pointing at the actual loopback receiving server, run `node scripts/verify-managed-host-boundaries.mjs` for queued/tool-child checks, append `--ownership-only` for ownership/child idle-turn/cancellation checks, or `--failed-switch-only` for injected failure/cleanup. `--case=ownership`, `--case=cancellation` or `--case=toolChild` narrows the ownership run. These use the normal authenticated CLI, create disposable project sessions, write `boundary-proof.json` in the printed project directory, and stop their own fake provider. The default run currently exits nonzero for the known queue failure; it is a regression check, not a passing support claim.

Append `--lifecycle-only` for backed-up scoped reload, deletion and two-project instance-isolation checks. It evicts only its disposable location through stock `/api/debug/location`, not every loaded location. For approved setup edits, run `node scripts/verify-managed-setup.mjs <global-pre-edit-backup> <project-pre-edit-backup>`: it checks only quota-map differences, registered IDs, cached usage, direct project options and a bounded credential-free NInfer health GET. No prompts or quota refresh are sent; sanitized evidence is saved under the approved temporary root. Confirm account mappings yourself: `openai -> codex` applies to a Codex OAuth account, not an arbitrary OpenAI API-key account.

Keep one Quartermaster entry per document; ambiguous duplicates fail closed. Higher-priority registrations replace the whole lower-priority settings file, not individual keys. Global, ancestor, and pathless winners are readable and not writable. A pathless winner has no sibling file, so its settings are empty. Only a winning registration inside the project can be written, and the writer rewrites that `quartermaster.jsonc` without changing the OpenCode config. The current source project-options reader uses the receiving server's ordered native documents, including ancestor/global layers, when exact-server provenance is available. Inherited and inline winners are read-only; unavailable provenance refuses editing without guessing files or starting another server. See the [options RPC contract](docs/PLUGIN_INTEGRATION.md#configuration-editing-capability) for discovery and JSONC boundaries. This repair does not re-certify historical deployment archives. Back up config before authorized changes. The stock config watcher can reload other locations after a global edit; a scoped disposable-location eviction is preferable for fixture-only reloads. Auxiliary reviewer config is startup-read and needs an authorized runtime reload.

The queued-input limit comes from [stock v2.0.26](https://github.com/anomalyco/opencode/tree/9b4ec5714d481559990db0a816d5dec19541a814):
`packages/core/src/session/runner/llm.ts` resolves the model before promoting
queued input. Transparent reselection needs a supported host selection hook at
execution, not event races, retry-after-send or HTTP rewriting.

## Dynamic test agent

The deny-all-tools `qm-test` primary agent, `quartermaster-test` subagent and
isolated host config are in [`examples/test-agent`](examples/test-agent/README.md).
Build the checkout first and replace example model IDs with enabled models.
From that directory, `opencode api get /api/agent` inspects catalog assignments
without inference. Running either agent uses inference; catalog labels and
model replies alone do not prove which provider served a request.

`npm test` exercises synthetic assignments (primary → backup → recovered primary), automatic replacement of host defaults/variants, explicit manual opt-out, failed admission and ownership isolation. These fixtures do not modify live host state. After `npm run build`, run `node scripts/verify-admission-host-contract.mjs` for the private loopback admission fixture. It accepts the installed OpenCode 2.0.25, 2.0.26, or 2.0.27 binary and records that version. It verifies automatic primary and child routing, later idle turns, unbound-to-bound agent changes, manual preservation and resume, unbound pass-through, and no-eligible rejection. This is not actual OpenChamber-managed request evidence or proof of queued execution ordering. Quota-aware refresh is implemented, but no live quota-driven recovery cycle is claimed; do not exhaust real quotas to test it.
