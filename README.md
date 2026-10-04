# Quartermaster

Native OpenCode V2 plugin for assigning agent models using preference plans and provider availability. Standalone routing comes first, followed by OMO Slim integration and an optional GUI.

See [implementation plan](docs/IMPLEMENTATION_PLAN.md) and [ID tracker](plans/quartermaster.plan.md). Native routing, cached usage, quota eligibility, work-type routing, failure cooldowns, local endpoint health, availability refresh, pins, and selection explanations are implemented; the Slim bridge is still pending.

## Development

Requires Node.js 23.6 or newer.

```sh
npm install
npm run build
npm test
npm run typecheck
```

`build` checks TypeScript without emitting files; Node 23.6+ runs the TypeScript plugin entrypoint directly, so no transpilation step is needed.

The local `opencode-usage.json` snapshot is live account state and is intentionally excluded from Git.

## Configuration

Quartermaster reads its settings from the plugin entry's `options` object in OpenCode V2 `opencode.json(c)`. The example [`examples/quartermaster.json`](examples/quartermaster.json) is that options object—not an OpenCode config file—so adding Quartermaster settings does not replace or rewrite unrelated OpenCode settings. In the snippet, replace `quartermaster` with the installed package name or a local plugin directory.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "quartermaster",
      "options": {
        "plans": { "review": ["provider-a/quality-model", "provider-b/backup-model"] },
        "agents": { "reviewer": "review" }
      }
    }
  ]
}
```

Candidates are ordered `providerID/modelID` strings or `{ "id": "providerID/modelID", "variant": "..." }` objects. Bindings must reference a configured plan; each plan must have unique, non-empty candidates. `usageSources` maps actual provider IDs to `go`, `codex`, or `cursor` usage sources. A confirmed limited source skips every mapped model; `quotaExemptModels` lists fully qualified models (all variants) that do not use that quota. Unknown or stale usage is not treated as exhausted, and estimated reset times alone do not restore eligibility. Durations are positive integer milliseconds (`providerCooldownMs` defaults to 300000; `localHealthTimeoutMs` to 2000). `localEndpoints` accepts loopback HTTP(S) URLs only and explicitly opts those providers into a bodyless GET health check with credentials omitted. Results are cached for five seconds; a failed check skips only models from that local provider.

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

OpenChamber currently has no documented authenticated bridge to the active OpenCode server, so Quartermaster does not ship an OpenChamber panel. See the [bridge feasibility findings](docs/OPENCHAMBER_BRIDGE.md). The example below only exposes OpenCode's `quartermaster-test` agent in OpenChamber; it is not a Quartermaster GUI.

## Native routing boundaries

Quartermaster preloads enabled models, cached usage status, and configured local endpoint health before applying bound choices through OpenCode V2's synchronous agent transform. It edits only the agent's model field; prompts, permissions, and other agent settings are retained. The client reads `opencode-usage.status({})` with a bounded timeout and normalizes its versioned snapshot; it never forces refresh or polls provider APIs. Configured mapped models with unknown usage are skipped as unknown, not classified as exhausted; unmapped models are unaffected by quota status, and remote providers are never health-probed. A changed eligibility snapshot takes effect after the router refreshes and calls the supported agent reload, for the next assignment only.

OpenCode keeps a session's selected model separate from its selected primary agent, so Quartermaster never changes an existing or explicitly selected session model. Configured subagents use their agent model by default. Agent transforms replay in registration order: Quartermaster overrides earlier model edits for bound agents, but a later transform may override Quartermaster. Load it after transforms it should take precedence over. No active-turn `switchModel` is used.

Structured provider outages cool down every model from that provider; model outages and model-scoped temporary rate limits affect only that model. Quota exhaustion, auth failures, cancellation, and generic errors do not create outage cooldowns. A matching success clears only that scope. Active cooldowns persist in plugin storage and are restored after restart. Every 60 seconds, Quartermaster reads cached usage and checks configured local endpoints; changed eligibility is debounced and applied at the next agent assignment. The routing handle accepts failure reports internally; cross-plugin reporting is added in #13.

## Dynamic test agent

The read-only `quartermaster-test` subagent and isolated host config are in [`examples/test-agent`](examples/test-agent/README.md). The checked-in model IDs are fixture placeholders; replace them with two enabled `providerID/modelID` entries before testing in a real host. To inspect the actual transformed agent without sending a model request, run `opencode api get /api/agent` from that example directory and inspect `data[]` for `quartermaster-test.model`. Open the same directory in OpenChamber to expose the subagent there; launching it through a parent agent sends inference and may use provider quota.

`npm test` exercises separate synthetic assignments (primary → backup → recovered primary), plus unbound-agent and explicit session-model invariants. Those fixtures do not modify live host state. Quota-aware refresh is implemented, but no live quota-driven recovery cycle is claimed; do not exhaust real quotas to test it.
