# Clean installation and release gate

Quartermaster is one native OpenCode V2 server plugin. Stock OpenChamber loads
the same package in its receiving OpenCode server: no panel, bridge, proxy or
custom host build is required. Registry publication is separate; this private
development package is installed from a locally supplied archive.

## Prerequisites and archive

- Node.js >=23.6 and npm for local installation; the archive contains compiled
  JavaScript and declarations, not a build toolchain.
- OpenCode V2 with awaited prompt admission and confirmed model switching.
  Record the actual server version, not just a CLI version.
- For OpenChamber, use its actual managed server's ordinary authenticated
  connection. A separate CLI server is not managed-host evidence. External
  servers require client-supported authentication and the necessary APIs.
- Keep the archive, SHA-256 and previous archive/config backup. A development
  version string alone does not identify archive contents.

From a checkout, `npm ci` then `npm run verify-package` builds in owned temporary
staging storage, packs without lifecycle scripts, installs into a clean temporary
project/home, checks exports/types and runs standalone loopback admission. Its
output gives archive, SHA-256, installed directory and evidence path. It does
not overwrite checkout `dist` or earlier archives, and does not alone certify
OpenChamber or every platform.

Copy the archive and verify its SHA-256 with `Get-FileHash -Algorithm SHA256`
(PowerShell) or `sha256sum` (Linux). Install into a chosen directory, not globally
or under OpenCode's automatic plugin discovery directories:

```sh
npm install --prefix .quartermaster --ignore-scripts --no-audit --no-fund --save-exact ./opencode-quartermaster-0.1.0.tgz
```

Installation fetches public dependencies but sends no inference. The package is
`opencode-quartermaster`, not the unrelated `quartermaster` npm package. A tarball
is an npm install input, not an `opencode plugin add` input.

## Registration scope

Back up the exact config before an authorized edit. Preserve unrelated models,
permissions, MCPs, agents and plugins; merge an entry, not a whole config file.

- **Project:** register once in `opencode.json(c)` or `.opencode/opencode.json(c)`.
  Paths are relative to that config file. A project-root installation requires
  `../.quartermaster/node_modules/opencode-quartermaster` from `.opencode/opencode.json`.
- **Global:** install in a chosen directory, such as a `quartermaster` subdirectory
  of the global config directory, then register once in
  `~/.config/opencode/opencode.json(c)` (or its configured XDG location). Use the
  installed relative/absolute destination path, never a maintainer checkout.
  Do not also enable an autoloaded copy.
- Project Quartermaster options replace global Quartermaster options **as a
  whole**, not per field: repeat required plans, bindings and maps. Keep one
  matching entry per document; ambiguous project duplicates fail closed.
- Native discovery searches ancestors and applies `.opencode` layers after
  direct files. The current source options writer consumes the receiving
  server's ordered native documents rather than guessing that order. It accepts
  comments and trailing-comma JSONC, but edits only a winning project-contained
  entry; inherited or inline winners are read-only. Unavailable exact-server
  provenance makes editing unavailable. See the [options RPC contract](PLUGIN_INTEGRATION.md#configuration-editing-capability)
  for the same-PID, no-start discovery boundary. This source repair does not
  re-certify previously recorded deployment archives.

Define the agent **and** bind its exact ID; bindings do not create agents. Replace
every `YOUR_...` below with enabled `providerID/modelID` values from the receiving
server (`opencode models` or the stock model picker). These are substitution
markers, not working fixture providers.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "agents": {
    "reviewer": { "mode": "all", "model": "YOUR_PROVIDER/YOUR_DEFAULT_MODEL" }
  },
  "plugins": [{
    "package": "./.quartermaster/node_modules/opencode-quartermaster",
    "options": {
      "plans": { "review": ["YOUR_PROVIDER/YOUR_PRIMARY_MODEL", "YOUR_BACKUP_PROVIDER/YOUR_BACKUP_MODEL"] },
      "agents": { "reviewer": "review" }
    }
  }]
}
```

This is a project-root example, not a replacement for an existing config. Bound
agents route automatically before the first provider request and on later idle
prompts. `/qm-manual` preserves that session/agent's deliberate model and variant;
`/qm-auto` resumes routing. Unbound agents and auxiliary requests are untouched.
No eligible candidate or an unconfirmed switch rejects automatic admission.

Usage integration is optional. Map actual provider IDs with `usageSources` only
after verifying `opencode-usage.status({})`: `opencode-go -> go`, OAuth
`openai -> codex` (not an API-key account), and `cursor -> cursor`. Do not invent
quota from an absent mapping. No provider polling or forced refresh is required.
`localEndpoints` optionally maps a local provider to its existing loopback
HTTP(S) GET health URL; probes omit credentials and cache for five seconds.
A stopped inference server is offline; installation never requires starting it.

## Receiving runtime and updates

Use the client's existing authenticated connection to the receiving server.
`opencode api --server <receiving-url> get /api/info` reports its version, PID
and URLs. For a project-scoped request, include `location[directory]` in the
query. Inspect `/api/plugin` and `/api/command` there, not on a separately started
CLI server. Call `/api/rpc/quartermaster/diagnoseSession` with
`{"input":{"sessionID":"<chat-id>"}}` through the same connection. Compare its
process ID, plugin version/instance, location, ownership and session model with
the server and installed package. A `cli` host label can describe a managed
child; a matching session ID alone proves nothing. Missing metadata is unknown.

`/qm-status` queues diagnostics without waking inference; stock hosts display
them only on a later normal turn, where they can become context. The diagnostic
RPC is immediate and read-only. Recommendations and request-hook observations
are not evidence of an HTTP send. Diagnose stale/multiple servers by comparing
PID/URLs, project and plugin instance before changing any configuration. Never
recover credentials or bypass authentication.

Keep the old archive/hash and exact config backup. Install the chosen replacement
archive with the same npm flags/path, preserving unrelated settings and files.
Then verify imports and the receiving runtime. Plans/bindings can be adopted at
idle boundaries, but startup-built services (health, quota, cooldown, exclusivity,
reporting and auxiliary reviewer configuration) may require an **authorized**
reload of that receiving runtime. Do not restart live servers merely to test.
The current source options-save RPC resolves native precedence when provenance
is available and backs up only its writable winning project file. Roll back the archive and only changed plugin
entry/options, not somebody else's later edits. Verify the reloaded instance.

## Release checklist

Keep one evidence bundle per exact archive SHA-256, not just package version:

- Archive name/version/hash, allowlisted contents, imports/types and clean
  installed paths; old/update/rollback configuration and unrelated-file checks.
- Standalone host version/PID and installed-copy admission/diagnostic evidence.
- Actual stock OpenChamber version and its authenticated managed server
  version/PID; installed-copy first-send, native child, manual/unbound, no-eligible,
  injected switch-failure cleanup, retry/cooldown/later-idle recovery,
  cancellation, queue safety and project/plugin-instance isolation traces.
- Distinguish auxiliary traffic, clean retries and partial continuation. Retain
  terminal failed-idle history and tool results, not just session summaries.
- OS/Node/host matrix, stock desktop/mobile/keyboard proof and owned-process/
  settings cleanup. Publish only with separate explicit approval.

Run `npm run verify-package -- --previous-archive=<retained-archive>` for an
isolated build/install and local archive replacement check. Reuse its archive
on another OS with `--archive=<same-archive> --executable=<host-executable>`.
With normal managed-host authentication, pass its printed installed directory
as `--plugin-root=<installed-directory>` to `scripts/verify-routing-tail.mjs`
and `scripts/verify-managed-host-boundaries.mjs`. Use `--case=queuedSafety`,
`--ownership-only`, `--lifecycle-only`, `--failed-switch-only` and
`--case=routingProof` for the documented independent cases. The default queued
reselection regression deliberately fails; do not count it as a passing gate.

Queued execution cannot transparently reselect on stock 2.0.26. An eligible
captured model may persist; an ineligible automatic request rejects before
sending and must be resent while idle. This is the accepted #42 limitation,
not reselection support. Failed 429 attempts have no separate completed UI row;
the wire trace is authoritative. Exhaustion can show a generic stopped-turn
message; native failed-idle history supplies the outcome. Do not infer serving
identity from a transient model picker during catalog loading.

## Verified private artifact (2026-10-13)

The local release gate passed for `opencode-quartermaster@0.1.0`, SDK dependency
`@opencode/plugin@2.0.23`, with 55 allowlisted files and archive SHA-256:

`6f23194e7ceb56e78bacba602426a73bd2bfda926ba9d891de4c1c24a68ff0a1`

This applies only to the exact private archive and tested combinations recorded
below. Its embedded docs are a pre-verification snapshot; final evidence is
recorded externally without changing the archive's bytes/hash. Other versions,
macOS, Linux-managed OpenChamber and physical mobile devices remain untested.
The queue/UI limitations above remain; no fork/proxy workaround, universal tool
exactly-once guarantee or registry publication is implied.

| Environment | Node | Host | Installed-copy result |
| --- | --- | --- | --- |
| Windows 11 Home, build 26200, x64 | 24.14.1 | Standalone OpenCode 2.0.27 | Clean install, imports/types, admission/child/controls/no-eligible; archive replacement/rollback preserved config and unrelated files |
| Ubuntu 24.04.3 LTS, WSL2, x64 | 24.14.1 | Standalone OpenCode 2.0.26 | Same archive/hash; clean install, imports/types and native admission/child/controls/no-eligible |
| Windows 11 Home, build 26200, x64 | 24.14.1 | Stock OpenChamber 2.3.1 / managed OpenCode 2.0.27 | Active installed-source identity; admission, native child, controls, queue/cancel, lifecycle/isolation, offline/synthetic quota, retry/recovery and terminal exhaustion |

Diagnostics and supported source lookup agreed with the actual managed receiving
process, not a substitute CLI server. Chrome 155.0.8059.40 verified painted
1440x900 desktop and 390x844 Android-emulated layouts, real model-search/composer
keyboard focus and Tab/Shift+Tab draft-agent cycling without sending. Native
session model/agent and the full UI settings hash were unchanged after approved
test-history restoration. Owned browsers/fixtures stopped; Ubuntu was restored
to its initially stopped state. Tests passed 179/179 and typecheck passed. Keep
the printed package/boundary/tail/UI receipts together with the archive hash.
