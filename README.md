# Quartermaster

OpenCode V2 plugin that assigns agent models from named plans and provider availability.

## Install

Requires Node.js 23.6 or newer. Add one plugin entry to the OpenCode project that should use it. The package value must be one of:

- `github:SypherXN/quartermaster` to install this repository
- a local directory path to a checkout
- `quartermaster` when that package name is already installed

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:SypherXN/quartermaster",
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

## Development

Maintainer checks, not part of install:

```sh
npm install
npm test
npm run typecheck
```

`npm run build` typechecks without emitting files. Node runs the TypeScript entry directly. The root `opencode.json` and `opencode-usage.json` are local state and are not part of the plugin.

## Configuration

Candidates are ordered `providerID/modelID` strings or `{ "id": "providerID/modelID", "variant": "..." }` objects. Bindings must reference a configured plan; each plan must have unique, non-empty candidates. `usageSources` maps actual provider IDs to `go`, `codex`, or `cursor` usage sources. A confirmed limited source skips every mapped model; `quotaExemptModels` lists fully qualified models (all variants) that do not use that quota. Unknown or stale usage is not treated as exhausted, and estimated reset times alone do not restore eligibility. Durations are positive integer milliseconds (`providerCooldownMs` defaults to 300000; `localHealthTimeoutMs` to 2000). `localEndpoints` accepts loopback HTTP(S) URLs only and explicitly opts those providers into a bodyless GET health check with credentials omitted. Results are cached for five seconds; a failed check skips only models from that local provider. `exclusiveModels` lists `providerID/modelID` values that only one session in this OpenCode process may call at a time. Other agents skip a busy model and take the next eligible candidate. The holding session keeps it for its own later steps. The slot expires 15 minutes after the last step event and is not shared across processes.

An absent agent/work-type binding means Quartermaster has no plan for that request, so the host-selected model remains unchanged. The intended precedence is explicit user model > eligible manual pin > explicitly supplied work type > agent binding > original host/Slim model. Pins may change priority but never bypass eligibility; Quartermaster will not infer work type from prompt text.

Pins are limited to candidates in the agent's configured plan and enabled model registry. They persist in OpenCode plugin storage across sessions for this project; they do not alter an active or explicitly selected session model. Selection explanations expose stable reason codes and per-candidate skip reasons.

The internal plan resolver accepts a caller-supplied work-type alias before the agent binding. An unknown alias falls back to that agent's binding with an `unknown-work-type-agent-fallback` reason; without an agent binding it returns `no-plan` with `unknown-work-type`. Explicit user model overrides bypass plan resolution.

## Cross-plugin API

Import the versioned RPC contract from the `quartermaster/rpc` package subpath and call it from another V2 plugin:

```ts
import { QUARTERMASTER_RPC, requestReport, requestSelection } from "quartermaster/rpc"

const selection = await requestSelection(ctx, { agent: "reviewer", workType: "review" })
// `selected`, `no-plan`, `no-eligible`, or safe `unavailable` fallback
const status = await ctx.rpc(QUARTERMASTER_RPC).status({})
const report = await requestReport(ctx, { since: Date.now() - 86_400_000, limit: 50 })
```

RPC responses carry `apiVersion: 1`; selection returns the model reference and structured selected/skipped reason codes. The API also exposes `explain`, `pin`, `unpin`, `reportFailure`, and `reportSuccess`. Invalid inputs and unavailable routing have typed errors. Status contains sanitized usage windows and reset metadata, never upstream error text or credentials. `select` only recommends a model; it does not switch an active session model. Consumers should handle `unavailable` by keeping their host-selected model.

`requestReport` reads bounded usage, budget, and observed retry-error summaries for the plugin's active project context. It never accepts caller-supplied ownership; requesting another project returns `unsupported` because this plugin API exposes no caller identity/authorization mechanism. Reports label unknown attribution and incomplete live-event coverage, and `refresh` only rereads the durable ledgers—it does not poll providers or replay events. See [telemetry reporting limits](docs/TOKEN_TELEMETRY.md).

## Native routing boundaries

Quartermaster preloads enabled models, cached usage status, and configured local endpoint health before applying bound choices through OpenCode V2's synchronous agent transform. It edits only the agent's model field; prompts, permissions, and other agent settings are retained. The client reads `opencode-usage.status({})` with a bounded timeout and normalizes its versioned snapshot; it never forces refresh or polls provider APIs. Configured mapped models with unknown usage are skipped as unknown, not classified as exhausted; unmapped models are unaffected by quota status, and remote providers are never health-probed. A changed eligibility snapshot takes effect after the router refreshes and calls the supported agent reload, for the next assignment only.

OpenCode keeps a session's selected model separate from its selected primary agent, so Quartermaster never changes an existing or explicitly selected session model. Configured subagents use their agent model by default. Agent transforms replay in registration order: Quartermaster overrides earlier model edits for bound agents, but a later transform may override Quartermaster. Load it after transforms it should take precedence over. No active-turn `switchModel` is used.

Structured provider outages cool down every model from that provider; model outages and model-scoped temporary rate limits affect only that model. Quota exhaustion, auth failures, cancellation, and generic errors do not create outage cooldowns. A matching success clears only that scope. Active cooldowns persist in plugin storage and are restored after restart. Every 60 seconds, Quartermaster reads cached usage and checks configured local endpoints; changed eligibility is debounced and applied at the next agent assignment. The routing handle accepts failure reports internally. Other plugins can report through the cross-plugin RPC.

## Dynamic test agent

The read-only `quartermaster-test` subagent and isolated host config are in [`examples/test-agent`](examples/test-agent/README.md). The checked-in model IDs are fixture placeholders; replace them with two enabled `providerID/modelID` entries before testing in a real host. To inspect the actual transformed agent without sending a model request, run `opencode api get /api/agent` from that example directory and inspect `data[]` for `quartermaster-test.model`. Open the same directory in OpenChamber to expose the subagent there; launching it through a parent agent sends inference and may use provider quota.

`npm test` exercises separate synthetic assignments (primary → backup → recovered primary), plus unbound-agent and explicit session-model invariants. Those fixtures do not modify live host state. Quota-aware refresh is implemented, but no live quota-driven recovery cycle is claimed; do not exhaust real quotas to test it.
