# OpenChamber bridge feasibility

**Current result (2026-10-01): a maintainer-authorized OpenChamber checkout now
contains a host-mediated bridge to the active project's Quartermaster RPC, and
it passed a live smoke test on a disposable host.** The SDK exposes an explicit
`quartermaster` capability on wire API v1. The host chooses the active project,
authenticates through its OpenCode runtime, and permits only read-only `select`,
`explain`, `status`, and `report` calls. The guest cannot choose project scope,
an endpoint, an RPC ID, or credentials. The bridge does not use `host.request`
or `serviceRequest`, add a proxy or listener, or expose OpenCode credentials.
The published-SDK finding below remains historical; this is a new first-party
OpenChamber capability in the authorized checkout.

## Published SDK surface reviewed

Official source reviewed: [OpenChamber SDK host docs](https://github.com/openchamber/openchamber/blob/main/packages/docs/content/docs/sdk/host.mdx),
[SDK API](https://github.com/openchamber/openchamber/blob/main/packages/sdk/API.md),
[contract.ts](https://github.com/openchamber/openchamber/blob/main/packages/sdk/src/contract.ts),
[host.ts](https://github.com/openchamber/openchamber/blob/main/packages/sdk/src/host.ts),
[manifest.ts](https://github.com/openchamber/openchamber/blob/main/packages/sdk/src/manifest.ts),
[guest services](https://github.com/openchamber/openchamber/blob/main/packages/sdk/GUEST_SERVICES.md),
and [SDK package.json](https://github.com/openchamber/openchamber/blob/main/packages/sdk/package.json).

The published SDK host/API and guest-services documentation were rechecked on
2026-09-30. `host.request` is
bound to the manifest's integration API origin and `serviceRequest` targets the
extension's own service; neither documents an active OpenCode server
location/auth handoff. This is documentation/source evidence, not a live host
smoke test.

The current source reports `@openchamber/sdk` 2.0.4, manifest API v1 and wire
envelope v1. Web and desktop load guests; VS Code and mobile are unsupported.
The docs/examples also mention SDK `^1.24.0`; no OpenChamber host-version
compatibility matrix was found, so the published version story is inconsistent.
These are current-source findings, not a tested OpenChamber installation.

`connectHost()` exposes active directory/session events and project/session
metadata APIs. Its `GuestConnection` is only `{ connected, account }`
(integration link state), not an OpenCode server address, port, or credential.
The published host-message contract reviewed above has no active OpenCode auth
handoff.

`host.request` is HTTPS-only to the extension manifest's declared integration
`apiOrigin`; the host attaches that integration's authorization. It cannot
target a different active-server origin. `host.serviceRequest` reaches only
the guest's own local service. That service receives its own loopback port and
service token; host secrets are withheld. `exec`/`sockets` permissions run with
the user's broad OS privileges and are not a sandbox or OpenCode RPC tunnel.

The project's OpenCode target is V2 2.0.18 (`docs/PLUGIN_INTEGRATION.md`). The
[current V2 client docs](https://opencode.ai/v2/docs/build/client) document
`POST /api/rpc/{rpcID}/{method}` and a `location.directory` option for project
context; the [API docs](https://opencode.ai/v2/docs/api) describe the endpoint's
401 response. A caller still needs the OpenCode server endpoint and
authorization. These docs provide no OpenChamber active-server discovery/auth
handoff and are not a live test of the project's target host version.

## Local implementation and verification

The iframe may learn the active project/session directory through the existing
guest context. `host.quartermaster` accepts no directory, and its `report`
input omits `projectID`. The host captures the active directory and calls the
fixed `quartermaster` RPC through OpenChamber's directory-scoped OpenCode client
and authenticated runtime. The guest does not choose a URL, auth header,
credential, directory, or RPC ID. A report result may contain Quartermaster's
`projectID`.

The host checks the explicit capability and enabled state, aborts on runtime
change or pane cleanup, and rejects stale runtime, directory, frame, or grant
results. SDK tests cover input/result validation and fixed scoped-client
transport, output limits, and abort behavior. A UI integration test covers grant
revocation while a call is in flight. Runtime, directory, and frame stale checks
are source-reviewed; only project switching and disconnect were exercised on
the live host.

## Live host smoke (2026-10-01)

- Used a disposable isolated OpenChamber/OpenCode host with fixture projects A
  and B. No packaged desktop credentials were used.
- Guest calls reached the real `POST /api/rpc/quartermaster/status` and
  `/api/rpc/quartermaster/report` routes through the host's authenticated
  runtime. Project A returned `status: "unconfigured"` for status and
  `status: "ok"` for report. The former is a valid Quartermaster response.
- Switched the active project from A to B in the host UI. The guest called
  status and report without sending a directory or project ID. The fresh report
  identified project B and had a different `projectID` from project A.
- Paused a real status response, disabled the guest, and confirmed the iframe
  disappeared and the in-flight request was canceled (`canceled: true`,
  `net::ERR_ABORTED`). The guest received no result. After re-enabling it with
  only the `quartermaster` grant and reopening the panel, a fresh report
  succeeded for project B.

The OpenChamber maintainers own the bridge implementation. The maintainer
authorized the #36 work in the OpenChamber checkout under `packages/sdk` and
`packages/ui`; Quartermaster owns the RPC contract and this evidence. The
2026-10-01 smoke did not itself finish #28 or #29. Those tasks are completed
separately; their panel, permission, and accessibility evidence is recorded on
each task. The smoke proves
active-project switching and disconnect isolation, not every stale-response
permutation. Directory/runtime/frame stale-result checks were source-reviewed,
and the automated UI test covers grant revocation while a call is in flight.

## Active-project options capability for #29

The options editor uses a distinct `quartermaster-options` capability. It does not widen #36's read-only `quartermaster` grant. The host checks the new grant and enabled state, binds each request to the active project, and exposes only fixed `readOptions` and `applyOptions` RPC methods. Guest input contains Quartermaster options and the revision returned by `read`; it cannot supply a path, project ID, endpoint, credential, or RPC ID.

Quartermaster routes these methods through the existing #33 project-options reader and writer. The writer validates options, refuses stale revisions, preserves unrelated project configuration, and rolls the original file back if the RPC AbortSignal cancels the write before its commit point. No absolute path or backup path is returned to the extension. #28 and #29 are completed; this section records the options capability boundary.
