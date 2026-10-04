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

## Configuration editing capability

The exported `QUARTERMASTER_RPC` descriptor includes project-options reads and
writes. Both methods use the directory bound when Quartermaster registers the
RPC. Inputs do not accept a path, directory, or project ID; responses return
options and a revision, not filesystem or backup paths.

| Method | Success response |
| --- | --- |
| `readOptions({})` | `apiVersion: 1`, `status: "ok"`, `options`, numeric `revision` |
| `applyOptions({ options, revision })` | `apiVersion: 1`, `status: "saved"`, persisted `options`, updated numeric `revision` |

Read before editing and pass the returned revision unchanged. `options` is the
complete replacement Quartermaster options object, not a partial patch. Preserve
settings the editor does not change. Authorized V2 plugin callers use
`ctx.rpc(QUARTERMASTER_RPC)` for both methods.

The reader and writer require exactly one matching project Quartermaster entry
across `opencode.json`, `opencode.jsonc`, `.opencode/opencode.json`, and
`.opencode/opencode.jsonc` in that directory. A match is the package name
`quartermaster`, or a `file:`, relative, or absolute path that resolves to this
package. Another name or path is left unchanged, including one that only
contains that word. They do not edit global or ancestor
configuration. The writer validates options, checks the file revision, creates a
`.quartermaster.bak` backup, and replaces only the entry's `options` object,
preserving unrelated configuration and JSONC comments outside that object.

The project root and existing configuration paths are filesystem-resolved before
reading. Config and backup targets must remain inside that resolved root;
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
The plugin rereads project options before later assignments; saving does not
change an active session model.

RPC calls do not carry an authenticated caller identity. Directory binding and a
supplied project ID are not write authorization; the calling host must authorize
access. OpenChamber uses a separate `quartermaster-options` capability for both
options reads and applies. Its `quartermaster` grant remains read-only. The host
checks the grant and enabled state, chooses the active directory, authenticates
the RPC, and cancels stale requests without giving the guest an endpoint or
credentials. The opted-in local gateway uses the same project-options reader
and writer directly for its fixed directory. The offline draft at
[`web/README.md`](../web/README.md) stays syntax-only.

## Browser UI serving and authentication

OpenCode V2 2.0.18 does not provide this server plugin a web UI/router/static-asset mount; `app` is metadata, and the CLI/TUI router is not a server web mount. CORS is not authentication. Quartermaster does not claim an authenticated OpenCode UI mount or browser-safe active-project session.

The completed gateway (`npm run local-ui`) is started separately from the plugin and binds to IPv4 loopback. It keeps credentials server-side, uses Basic local-service auth, fixes location at startup, checks that the report belongs to that directory, and exposes the report request plus project-options load and apply, not a general proxy. Local processes can still access the listener; stop it when finished and treat telemetry as sensitive. It does not follow the host's active-project switches. See [`web/README.md`](../web/README.md).

#33 project writing is completed through that gateway. #36's host-mediated OpenChamber handoff is implemented separately; this gateway does not provide it.

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
