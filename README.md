# Quartermaster

OpenCode V2 plugin that assigns agent models from named plans and provider availability.

## Install

Requires Node.js 23.6 or newer. The portable package is `opencode-quartermaster@0.1.0`; the plugin and RPC ID stay `quartermaster`. It is not published. `private: true` deliberately blocks registry publishing; local packing and installation still work. The npm name returned 404 on 2026-10-08, which is not a reservation. Do not install the unrelated npm package named `quartermaster`.

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

Add exactly one plugin entry to the destination project's OpenCode config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./.quartermaster/node_modules/opencode-quartermaster",
      "options": {
        "plans": { "review": ["provider-a/quality-model", "provider-b/backup-model"] },
        "agents": { "reviewer": "review" }
      }
    }
  ]
}
```

Replace the model ids with enabled `providerID/modelID` values from `opencode models`. Settings live only in that entry's `options` object. [`examples/quartermaster.json`](examples/quartermaster.json) is the options object alone, not a full OpenCode config, so it does not replace unrelated settings.

On an OpenChamber build that includes the Quartermaster panel, allow `quartermaster` to read reports and `quartermaster-options` to save. The read grant cannot save. The panel is part of OpenChamber, not this package. See [the bridge](docs/OPENCHAMBER_BRIDGE.md).

A checkout can also start the optional local page with `npm run local-ui`. See [`web/README.md`](web/README.md).

### Package policy and updates

The archive includes compiled JavaScript, type declarations, public docs and the MIT license; it excludes source/tests, examples, web UI, user config, usage files, plans, logs and credentials. Documentation links to examples/web refer to the repository, not archive contents. Checkout installs require `npm ci` then `npm run build` before pointing OpenCode at the checkout. The runtime dependency is pinned to the tested `@opencode/plugin` 2.0.23, not `latest`; the standalone host smoke accepts OpenCode 2.0.25 or 2.0.26 and records the actual version. The packaged clean install was verified on 2.0.25; the updated checkout fixture also passes on 2.0.26. Other host/Node versions and Unix deployment remain unverified until the dual-host gate.

For updates, retain the previous archive/hash and back up the exact destination config. Install a specific replacement archive, verify its root/RPC imports and receiving-runtime diagnostics, then restart only with authorization if required. Roll back by reinstalling the retained archive and restoring only the changed plugin entry/options from the backup. After a separately authorized registry release, `opencode-quartermaster@<exact-version>` will be the npm entry; it is not an available install route yet. Publishing, removing the private guard, credentials, registry uploads and release tags require separate approval.

### Stock OpenChamber setup

OpenChamber uses the same native OpenCode server plugin; no panel, bridge, fork or proxy is required for routing. Define the agent in OpenCode and bind that exact agent ID under Quartermaster `options.agents`. A plan binding does not create the agent. Check enabled model IDs in the receiving project's registry rather than assuming a provider/model name is available.

Use one Quartermaster entry per config document. A project-local Quartermaster options object replaces the global Quartermaster options as a whole, not per key; repeat every binding/map needed at that location. Duplicate entries are rejected by the project-options reader. Keep unrelated host settings intact, back up the exact file before an authorized edit, and restart the actual receiving server only with authorization when startup-fixed settings change. The options-save RPC makes a `.quartermaster.bak` backup; it is not permission to edit user configuration automatically.

Confirm the handling process with `/qm-status` or the immediate diagnostic RPC below, then correlate its PID with host process ownership. A host name of `cli` can also describe an OpenChamber-managed child; neither that label nor matching session IDs proves which server handled the chat. An unbound `build` agent is expected to stay on its host model: select an already defined bound agent rather than adding bindings implicitly. Missing RPC/commands mean checking plugin loading and location scope before diagnosing selection.

Quota integration is optional: verify `opencode-usage.status({})` exposes `go`, `codex` or `cursor`, then deliberately map actual provider IDs through `usageSources`; absent maps report `unconfigured`, not available quota. For NInfer, verify the configured loopback GET endpoint (for example `http://127.0.0.1:8080/v1/models`) in the receiving runtime; a stopped server reports offline. Do not start inference, exhaust quotas, recover credentials or change maps merely to obtain a passing test. Jev Auto and custom reviewer generation are separate paths, not substitutes for native bound-agent admission proof.

## Development

Maintainer checks, not part of install:

```sh
npm install
npm test
npm run typecheck
```

`npm run build` emits JavaScript and declarations into `dist`; `npm run typecheck` checks without emitting. The root `opencode.json` and `opencode-usage.json` are local state and are not part of the plugin.

## Configuration

Candidates are ordered `providerID/modelID` strings or `{ "id": "providerID/modelID", "variant": "..." }` objects. Bindings must reference a configured plan; each plan must have unique, non-empty candidates. `usageSources` maps actual provider IDs to `go`, `codex`, or `cursor` usage sources. A confirmed limited source skips every mapped model; `quotaExemptModels` lists fully qualified models (all variants) that do not use that quota. Unknown or stale usage is not treated as exhausted, and estimated reset times alone do not restore eligibility. Durations are positive integer milliseconds (`providerCooldownMs` defaults to 300000; `localHealthTimeoutMs` to 2000). `localEndpoints` accepts loopback HTTP(S) URLs only and explicitly opts those providers into a bodyless GET health check with credentials omitted. Results are cached for five seconds; a failed check skips only models from that local provider. Managed agents refresh eligibility at prompt admission, selection/explanation, and safe retry-selection boundaries, not on every model dispatch; quota reads use the usage plugin's cached `status({})` and leave provider polling to that plugin. `exclusiveModels` lists `providerID/modelID` values guarded by an in-memory lease held across the owning session's turn. The lease manager is per plugin instance, not shared between project instances or processes. Another session handled by that same router skips a busy exclusive model and takes the next eligible candidate. Only primary model requests take the lease; compaction, title, and generate requests are not gated. The slot expires 15 minutes after acquisition or the last streamed step event.

An absent agent/work-type binding means Quartermaster has no plan for that request, so the host-selected model remains unchanged. For explicit resolver/RPC inputs, precedence is explicit user model > eligible manual pin > supplied work type > agent binding > original host/Slim model. Automatic session admission instead follows the bound plan unless `/qm-manual` opts that session out; picker choices are not resolver overrides. Pins never bypass eligibility, and Quartermaster does not infer work type from prompt text.

Bound agents use Quartermaster automatic routing by default. In OpenCode's stock TUI, use `/qm-manual` before a deliberate model/variant change to leave that session's choices to the host; use `/qm-auto` to resume Quartermaster routing. Stock host hooks do not expose reliable provenance for same-model re-selection, so the default may replace an inherited or pre-first-prompt model/variant choice. The prompt hook awaits any needed model switch before admission and rejects the prompt if no eligible model can be selected or the switch fails.

Pins are validated against the agent's configured plan and enabled model registry when loaded or set. They persist under a project-scoped plugin-storage key and are revalidated after project-option adoption and registry refresh. The legacy shared key is used only when no project identity is available; its values are not imported into project namespaces. A pin changes the next selection, not an active turn. Selection explanations expose stable reason codes and per-candidate skip reasons.

The internal plan resolver accepts a caller-supplied work-type alias before the agent binding. An unknown alias falls back to that agent's binding with an `unknown-work-type-agent-fallback` reason; without an agent binding it returns `no-plan` with `unknown-work-type`. Explicit user model overrides bypass plan resolution.

### Diagnose the handling runtime

Run `/qm-status` in the chat being diagnosed. It queues a JSON diagnostic with `delivery:"queue"` and `resume:false`, without waking execution or changing the model, ownership, pins, leases or configuration. On stock OpenCode 2.0.25 and 2.0.26 it stays in the pending inbox, not the visible history, until a later normal turn delivers it; it can then become model context. Immediate in-chat display without inference is not supported by this command API. For immediate output without queuing anything, call the read-only `quartermaster.diagnoseSession({ sessionID })` RPC through the actual receiving server's authenticated, project-scoped `/api/rpc/quartermaster/diagnoseSession` endpoint with `{ "input": { "sessionID": "ses_..." } }`.

Both paths report the loaded plugin version, host-reported app version, local process ID and per-load plugin-instance ID, project/location, binding/plan, automatic/manual/unbound mode, authoritative session model/variant, cached recommendation and skip reasons. Missing metadata is unknown; matching session IDs across servers is not runtime identity. A known project mismatch hides the other session's agent/model and reports `scope:"mismatch"`; missing project identity reports `scope:"unknown"`, not confirmed ownership.

Availability is the active router's cached snapshot, not a forced refresh or configuration reread. Snapshot age, refresh interval, health-cache duration and available quota timestamps are shown. Quota `unconfigured` means no source mapping; `local-offline` means a configured health probe failed; `not-in-registry` means a candidate is not enabled. Recommendations do not switch models or guarantee a send. Primary evidence is only a `model.request` hook observation since this instance loaded, not an HTTP-send/success claim; auxiliary requests are excluded. Session and ownership reads are bounded; unknown reads do not expose raw errors or credentials.

If the command is absent, inspect the actual receiving server's project-scoped `/api/plugin` and `/api/command` through normal host authentication. Check plugin loading, effective project options and server version; a separate CLI server is not OpenChamber-runtime proof. Startup-fixed options may need an authorized restart. Do not recover credentials or bypass authentication. Native OpenChamber command/display proof remains part of the stock-host verification gate.

## Cross-plugin API

Import the versioned RPC contract from the `opencode-quartermaster/rpc` package subpath and call it from another V2 plugin:

```ts
import { QUARTERMASTER_RPC, requestReport, requestSelection } from "opencode-quartermaster/rpc"

const selection = await requestSelection(ctx, { agent: "reviewer", workType: "review" })
// `selected`, `no-plan`, `no-eligible`, or safe `unavailable` fallback
const status = await ctx.rpc(QUARTERMASTER_RPC).status({})
const report = await requestReport(ctx, { since: Date.now() - 86_400_000, limit: 50 })
```

RPC responses carry `apiVersion: 1`; selection returns the model reference and structured selected/skipped reason codes. The API also exposes `explain`, `pin`, `unpin`, `reportFailure`, and `reportSuccess`. Invalid inputs and unavailable routing have typed errors. Status contains sanitized usage windows and reset metadata, never upstream error text or credentials. `select` only recommends a model; it does not switch an active session model. Consumers should handle `unavailable` by keeping their host-selected model.

`requestReport` reads bounded usage, budget, and observed retry-error summaries for the plugin's active project context. It never accepts caller-supplied ownership; requesting another project returns `unsupported` because this plugin API exposes no caller identity/authorization mechanism. Reports label unknown attribution and incomplete live-event coverage, and `refresh` only rereads the durable ledgers—it does not poll providers or replay events. See [telemetry reporting limits](docs/TOKEN_TELEMETRY.md).

## Native routing boundaries

Quartermaster preloads enabled models, cached usage status, and configured local endpoint health before applying bound choices through OpenCode V2's synchronous agent transform. It edits only the agent's model field; prompts, permissions, and other agent settings are retained. The client reads `opencode-usage.status({})` with a bounded timeout and normalizes its versioned snapshot; it never forces refresh or polls provider APIs. Configured mapped models with unknown usage are skipped as unknown, not classified as exhausted; unmapped models are unaffected by quota status, and remote providers are never health-probed. A changed eligibility snapshot takes effect after the router refreshes and calls the supported agent reload, for the next assignment only.

OpenCode keeps a session's selected model separate from its agent. At an idle prompt boundary, Quartermaster selects from a bound agent's current plan, awaits `switchModel` if needed, and confirms the authoritative selection before admission. An out-of-plan default or changed model/variant does not imply a manual opt-out. `/qm-manual` preserves host choices at admission and retry selection until `/qm-auto` resumes; the opt-out is scoped to the stored project/session/agent and survives plugin reload. Agent changes and session deletion clear old ownership. Failed ownership reads, no eligible model or an unconfirmed switch reject automatic admission and release reservations.

Quartermaster does not switch an active primary response for queued/steered input or spend inference to choose a route. Automatically owned bound primary requests now recheck ownership, plan membership and availability in `model.request`, before acquiring an exclusive request lease or sending. A stale/ineligible captured model is rejected and its reservation released; no model or HTTP request is rewritten. Manual opt-outs, unbound agents and auxiliary requests bypass this safety guard. Health uses the existing five-second cache and usage remains cached, so this is not continuous availability monitoring. Execution-boundary reselection remains unsupported on stock OpenCode 2.0.26: after rejection, send again when idle to select a fallback. The prompt hook runs at enqueue; execution hooks cannot replace the captured model. Configured subagents receive the agent transform, but direct generation/custom reviewer paths are not automatically covered by an agent name. Transforms replay in registration order: later transforms may override Quartermaster. Load it after model transforms it should take precedence over.

Safe, correlated primary failures can select a remaining eligible backup during a host-approved native retry and create a scoped outage/rate-limit cooldown. Quartermaster does not create another retry loop or change the host's retry approval/delay. Auth, confirmed quota, cancellation and generic errors do not create outage cooldowns or select a backup. Other owned outcomes can use the reportFailure/reportSuccess RPCs. Cooldowns persist; recovery affects a later automatic admission, never an idle session or active response. Availability refresh reads cached usage and configured loopback health, not provider APIs.

### Managed-host verification limits

**Current status (2026-10-13):** #43 and #46 are complete for the exact private archive and tested Windows/Ubuntu/stock-managed combinations in [Deployment](docs/DEPLOYMENT.md#verified-private-artifact-2026-10-13). Packaged request/source identity, painted desktop/mobile UI, keyboard and cleanup checks passed. The dated 2026-10-09 notes below are historical; accepted queued behavior and native UI limits remain. Other combinations and publication are not implied.

**Accepted known behavior (2026-10-09):** Queued input from users or automation is not automatically rerouted at execution time. It can keep a still-eligible prior model; an ineligible automatic selection is rejected before sending and must be resent when idle. The user accepted this limitation, closing #42 with seven verified criteria plus one accepted exception, not eight verified criteria. `--case=queuedSafety` proved zero additional sends after offline health-cache expiry, reservation recovery and unchanged manual/unbound choices. Failed-idle history can disagree with the host's succeeded session summary. Ownership, cancellation, native child, reload/deletion/isolation and injected-switch cleanup checks passed with the changed compiled plugin; all 177 tests, typecheck and build passed. No host source, permission policy or upstream issue/comment changed. #43/#46 and full dual-host certification remain pending.

On 2026-10-09, stock OpenChamber-managed OpenCode 2.0.26 passed loopback checks for automatic first-send routing, manual opt-out/resume, separate-fork ownership, unbound pass-through, no-eligible rejection, and a native tool-created subagent's first provider request. A test-only adapter injected one client-side `switchModel` exception: admission sent zero provider requests, and a different session acquired the exclusive model, proving reservation release. This is not a naturally occurring host switch rejection. Queued reselection remains unsupported but is now an accepted #42 limitation; full dual-host certification still requires #43/#46. All test-owned servers were stopped; no OpenChamber source or permission rules changed.

Further managed checks passed persistent manual same-model/variant and out-of-plan choices, agent-change resets, separate-session ownership, native child later idle/manual/resume turns, busy exclusive-model fallback and cancellation cleanup. Scoped location reload preserved manual choices in a new plugin instance; deletion cleared observations and a new session routed automatically. Two project/plugin instances in the same receiving process independently acquired the same exclusive model. This proves instance isolation, not cross-process coordination. Approved quota mappings and the offline NInfer health URL were verified against backups and effective project options. Each fixture uses unique provider IDs to avoid persisted test cooldown contamination; production state is not cleared.

With explicit authorization and `OPENCODE_PERMISSION_REVIEWER_HOST_URL` pointing at the actual loopback receiving server, run `node scripts/verify-managed-host-boundaries.mjs` for queued/tool-child checks, append `--ownership-only` for ownership/child idle-turn/cancellation checks, or `--failed-switch-only` for injected failure/cleanup. `--case=ownership`, `--case=cancellation` or `--case=toolChild` narrows the ownership run. These use the normal authenticated CLI, create disposable project sessions, write `boundary-proof.json` in the printed project directory, and stop their own fake provider. The default run currently exits nonzero for the known queue failure; it is a regression check, not a passing support claim.

Append `--lifecycle-only` for backed-up scoped reload, deletion and two-project instance-isolation checks. It evicts only its disposable location through stock `/api/debug/location`, not every loaded location. For approved setup edits, run `node scripts/verify-managed-setup.mjs <global-pre-edit-backup> <project-pre-edit-backup>`: it checks only quota-map differences, registered IDs, cached usage, direct project options and a bounded credential-free NInfer health GET. No prompts or quota refresh are sent; sanitized evidence is saved under the approved temporary root. Confirm account mappings yourself: `openai -> codex` applies to a Codex OAuth account, not an arbitrary OpenAI API-key account.

Keep one Quartermaster entry per document; ambiguous duplicates fail closed. Higher-priority declarations replace the whole lower-priority options object, not individual keys. The current source project-options reader uses the receiving server's ordered native documents, including ancestor/global layers, when exact-server provenance is available. Inherited and inline winners are read-only; unavailable provenance refuses editing without guessing files or starting another server. See the [options RPC contract](docs/PLUGIN_INTEGRATION.md#configuration-editing-capability) for discovery and JSONC boundaries. This repair does not re-certify historical deployment archives. Back up config before authorized changes. The stock config watcher can reload other locations after a global edit; a scoped disposable-location eviction is preferable for fixture-only reloads. Auxiliary reviewer config is startup-read and needs an authorized runtime reload.

Queued reselection is an accepted known limitation, not a supported capability. In [stock v2.0.26](https://github.com/anomalyco/opencode/tree/9b4ec5714d481559990db0a816d5dec19541a814), `packages/core/src/session/runner/llm.ts` resolves the model before promoting queued input. The awaited `prompt` hook runs only during enqueue; execution hooks cannot override the captured model. Transparent reselection would need a supported selection hook after promotion and before resolution. No upstream issue or host patch is planned; event races, retry-after-send and HTTP rewriting are not substitutes.

## Dynamic test agent

The read-only `qm-test` primary agent and isolated host config are in [`examples/test-agent`](examples/test-agent/README.md). The checked-in model IDs are fixture placeholders; replace them with two enabled `providerID/modelID` entries before testing in a real host. To inspect the actual transformed agent without sending a model request, run `opencode api get /api/agent` from that example directory and inspect `data[]` for `qm-test.model`. Open the same directory in OpenChamber to expose the agent there; launching it sends inference and may use provider quota.

`npm test` exercises synthetic assignments (primary → backup → recovered primary), automatic replacement of host defaults/variants, explicit manual opt-out, failed admission and ownership isolation. These fixtures do not modify live host state. After `npm run build`, run `node scripts/verify-admission-host-contract.mjs` for the private loopback admission fixture. It verifies automatic primary/child routing, manual preservation/resume, unbound pass-through and no-eligible rejection on OpenCode 2.0.25 and 2.0.26; the 2.0.26 run additionally verifies later idle turns and unbound-to-bound agent changes. This is not actual OpenChamber-managed request evidence or proof of queued execution ordering. Quota-aware refresh is implemented, but no live quota-driven recovery cycle is claimed; do not exhaust real quotas to test it.
