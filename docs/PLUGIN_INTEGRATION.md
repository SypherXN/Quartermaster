# Integrating Other Plugins

Quartermaster exposes model routing through the OpenCode V2 plugin RPC
boundary. Consumers should use this RPC, not import Quartermaster internals
or read its private state.

The canonical descriptor and helper are exported from `quartermaster/rpc`.
Quartermaster is currently a private package, so consumers need a workspace
link or another resolver that makes this subpath available.

## Assignment-time selection

Call `requestSelection` from async plugin setup before registering a
synchronous transform. Cache the result and apply it in the transform; never
await RPC inside the callback.

```ts
import { requestSelection } from 'quartermaster/rpc'

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

`hasExplicitOverride` and `allowedModelIDs` are placeholders for the
consumer's own precedence and candidate checks. Apply Quartermaster's model
only to a new assignment that has no explicit host/user choice and only when
that model is allowed by the consumer. A consumer's explicit variant wins;
otherwise use the selection's variant with the model.

`select` recommends a model for an assignment; it does not change the active
session model. Do not use `switchModel` as an automatic fallback.

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
- Quartermaster checks its own registered/eligible models and tries plan
  candidates in order. A manual pin is considered before plan candidates, but
  still has to be registered and eligible.
- The consumer remains authoritative: preserve explicit host/user model
  choices and active scalar presets. For candidate chains, apply the result
  only when `providerID/modelID` belongs to that chain. An explicit consumer
  variant wins; otherwise prefer that chain entry's variant, then the returned
  Quartermaster variant.

## Optional RPC methods

Use the same exported `QUARTERMASTER_RPC` descriptor for other supported
operations:

- `explain({ agent })` explains a routing decision; reserve it for diagnostics
  or an explicit request.
- `status({})` returns Quartermaster's current status.
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
