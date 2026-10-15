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
matching declaration replaces the complete lower-priority options object;
matches in different documents are normal overrides. Multiple matching entries
in one document fail closed. A match is the package name
`opencode-quartermaster` with an optional `@version` (legacy `quartermaster` entries
are still recognized for existing configs, not a recommendation to install that npm name), `github:SypherXN/quartermaster`
with an optional `#ref` or `.git` suffix, that same repository as an
`https://github.com/` or `git+https://github.com/` URL, or a `file:`, relative,
or absolute path that resolves to this install. Another name or path is left
unchanged, including one that only contains that word. An effective global,
ancestor or pathless inline declaration is readable with `writable: false` and
revision zero, but cannot be edited through the project writer. Only a winning
document contained in the bound project directory with an existing `options`
object is writable; the editor does not insert plugin entries or options. The writer
validates options, checks an opaque content-and-path revision, creates a
`.quartermaster.bak` backup, and replaces only the entry's `options` object,
preserving unrelated configuration, comments and JSONC trailing commas outside
that object. Pass the revision unchanged; it is not a timestamp.

At plugin startup, Quartermaster first parses OpenCode's resolved plugin options,
then adopts the winning native declaration when its provenance is available.
This is complete options replacement, not a key-by-key merge with global
options. Invalid or unavailable provenance, no matching declaration or ambiguous
entries in one document leave startup's host-supplied options unchanged. A
different project may resolve a different declaration.

The gateway uses its existing authenticated connection and validates its fixed
directory before requesting native configuration sources. In the plugin, normal
SDK service discovery never starts a server, and `/api/info` must identify this
process's PID before configuration is read. Unregistered services, a different
PID or unavailable provenance make editing unavailable; there is no filesystem
guess or substitute server. These paths have disposable-file and authenticated
loopback tests, not a new live-host certification. The project root and existing
configuration paths are
filesystem-resolved before reading. Config and backup targets must remain inside that resolved root;
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
and writer directly for its fixed directory. The offline draft at
[`web/README.md`](../web/README.md) stays syntax-only.

## Browser UI serving and authentication

The OpenCode V2 2.0.23 plugin surface used by this project does not provide this server plugin a web UI/router/static-asset mount; `app` is metadata, and the CLI/TUI router is not a server web mount. CORS is not authentication. Quartermaster does not claim an authenticated OpenCode UI mount or browser-safe active-project session.

The optional gateway (`npm run local-ui`) starts separately from the plugin and
binds to IPv4 loopback. It keeps credentials server-side, uses Basic local-service
auth, fixes the directory at startup and checks report ownership. Its routes load
reports and read/apply project options; it is not a general proxy. Local processes
can access the listener, including its writer. Stop it when finished and treat
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
`node scripts/verify-retry-host-contract.mjs` with an installed **2.0.24** binary.
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

Routing classification uses structured type/status only; it ignores messages
and response bodies and does not persist raw errors. Rate limits (429) create a
model-scoped temporary cooldown. Retry-approved internal/transport and 408,
409, or 5xx outage signals may switch to an eligible backup. Confirmed quota,
auth, and permission errors do not create outage cooldowns or switch models.
Missing-model/no-route errors may cool down that model for later assignments
but remain terminal in the current execution. Context overflow, content
filtering, unsupported operations, invalid output, timeouts, and unknown errors
remain terminal for Quartermaster selection; the host may still retry the same
model under its own policy. Cooldowns affect subsequent selection, including
safe retry selection and later prompt admission. Quartermaster excludes already
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
- `report({ since?, until?, limit?, offset?, refresh? })` reads the active
  project's bounded telemetry summary. `requestReport` adds timeout/response
  validation. Plugin attribution uses the separate `reportPluginUsage` method;
  see [telemetry contracts and limits](TOKEN_TELEMETRY.md).
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
