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
- The highest-priority Quartermaster registration wins. Its sibling `quartermaster.jsonc` replaces lower-priority settings **as a whole**, not per field. Repeat required plans, bindings and maps. Keep one matching entry per document; ambiguous duplicates fail closed. Non-empty `plugins[].options` is rejected. Omit plugin options, or leave them empty.
- Native discovery searches ancestors and applies `.opencode` layers after direct files. The current source settings writer consumes the receiving server's ordered native documents rather than guessing that order. It reads comments and trailing-comma JSONC. It rewrites only `quartermaster.jsonc` beside a winning registration inside the project. Global, ancestor, and pathless winners are read-only. A pathless winner has no sibling file, so its settings are empty. A missing settings file means `{}`. The OpenCode config bytes stay unchanged. Unavailable exact-server provenance makes editing unavailable. See the [options RPC contract](PLUGIN_INTEGRATION.md#configuration-editing-capability) for the same-PID, no-start discovery boundary. This source repair does not re-certify previously recorded deployment archives.

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
    "package": "./.quartermaster/node_modules/opencode-quartermaster"
  }]
}
```

Settings in the sibling `quartermaster.jsonc`:

```jsonc
{
  "plans": { "review": ["YOUR_PROVIDER/YOUR_PRIMARY_MODEL", "YOUR_BACKUP_PROVIDER/YOUR_BACKUP_MODEL"] },
  "agents": { "reviewer": "review" }
}
```

This is a project-root example, not a replacement for an existing config. Bound
agents route automatically before the first provider request and on later idle
prompts. `/qm-manual` preserves that session/agent's deliberate model and variant;
`/qm-auto` resumes routing. Unbound agents keep their host-selected model, and
auxiliary requests are not routed. If `exclusiveModels` is configured, its lease
gate still applies to listed primary requests, including manual and unbound
ones. No eligible candidate or an unconfirmed switch rejects automatic admission.

Usage integration is optional. Map actual provider IDs with `usageSources` only
after verifying `opencode-usage.status({})`: `opencode-go -> go`, OAuth
`openai -> codex` (not an API-key account), and `cursor -> cursor`. Do not invent
quota from an absent mapping. No provider polling or forced refresh is required.
`localEndpoints` optionally maps a local provider to its existing loopback
HTTP(S) GET health URL; probes omit credentials and cache for five seconds.
A stopped inference server is offline; installation never requires starting it.

Recovery probing is opt-in and off by default. `probeRateLimits` lists the
fully qualified models that may be checked for rate-limit recovery,
`probeIntervalMs` sets the base interval (default 300000) and
`probeMaxBackoffMs` sets the longest backoff between two probes of one bucket
(default 3600000): the base interval is the poll cadence, and the provider
cooldown stays the floor of the skip window. The interval doubles per failed
probe, so the default gaps are 10, 20, 40 and then 60 minutes, and 60 minutes
after that. A probe spends one real
provider request slot and a tiny completion, so enable it only where that is
acceptable, such as a free tier; it is sent by the host, because the Zen free
tier rejects callers outside OpenCode. A probe never replays a user turn.
Without the list, no provider is ever polled for its rate-limit state. The
long cap is deliberate — a shared free-tier bucket can stay capped for hours —
but it means the recovery of a bucket can go unnoticed for up to the cap, so
lower `probeMaxBackoffMs` if you want the model back sooner.

## Direct-call modules

`modules` is optional and compatible with existing native plans and bindings. Omit it, or set `{}`, to leave chat routing unchanged. A profile does not register models, bind agents or authorize payment. When a higher-priority registration wins, repeat `modules` in that registration's `quartermaster.jsonc` with the plans and bindings that file must keep.

Turning on a consumer is separate from installing Quartermaster. The
permission-reviewer route stays off unless global `permission-reviewer.jsonc`
sets `moduleRouting.enabled` to true. A project OpenCode file, prompt, command
or repository file cannot enable that route or permit a paid model. This
package does not build, install, or activate the reviewer plugin. Build and
enable that package on its own, and do not bind its runtime agent in
Quartermaster's `agents` map.

Quartermaster stores only the configured cooldown: model `cooldownMs`, otherwise
the module default, otherwise `providerCooldownMs`. That is time out of
rotation, not the consumer's review deadline and not a discovered `Retry-After`
or provider quota window. The consumer owns its deadline. Module helpers default
to a two-second RPC budget and share the caller's abort signal.

The [2026-10-13 archive](#verified-private-artifact-2026-10-13) predates
`selectModule` and `reportModuleCooldown`. This checkout's `npm test`,
`npm run typecheck` and `npm run build` cover the current source. Artifact
creation was not rerun for the module work, so that historical hash is not
evidence for the new exports. Permission-reviewer checks that mock Quartermaster
and the System One client are not a live Quartermaster process, a real Jev
limit or an activated install. OpenCode V1 has no Quartermaster RPC client;
enabling the reviewer route there fails closed. Publishing, restarts and paid
live validation were not run.

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
Then verify imports and the receiving runtime. Existing routing hooks can adopt
plans and bindings at idle boundaries. Changes to startup-built services or hook
registration, such as budgets, reporting or exclusivity, may require an
**authorized** reload. Do not restart live servers merely to test.
The current source options-save RPC resolves native precedence when provenance is available and backs up only an existing winning project `quartermaster.jsonc`. It leaves the OpenCode config unchanged. Roll back the archive and only the changed registration and settings file, not somebody else's later edits. Verify the reloaded instance.

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
sending and must be resent while idle. This is the accepted queued-model limitation,
not reselection support. Failed 429 attempts have no separate completed UI row;
the wire trace is authoritative. Exhaustion can show a generic stopped-turn
message; native failed-idle history supplies the outcome. Do not infer serving
identity from a transient model picker during catalog loading.

## Verified private artifact (2026-10-13)

The local release gate passed for `opencode-quartermaster@0.1.0`, SDK dependency
`@opencode/plugin@2.0.23`, with 55 allowlisted files and archive SHA-256:

`6f23194e7ceb56e78bacba602426a73bd2bfda926ba9d891de4c1c24a68ff0a1`

This applies only to the exact private archive and tested combinations recorded
below. That archive does not include the direct-call module API. Its embedded docs are a pre-verification snapshot; final evidence is
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
