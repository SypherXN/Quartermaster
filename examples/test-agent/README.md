# Quartermaster test agent

This isolated OpenCode project loads the local Quartermaster package, the read-only `quartermaster-test` subagent, and the existing `qm-test` primary agent. Both bind to the same two-candidate plan: `ninfer/qwen3.8-27b` first, then `opencode/space-bunny-free`.

The project also probes `http://127.0.0.1:8080/v1/models` for the `ninfer`
provider. When that loopback endpoint is offline, Quartermaster skips Qwen and
selects Space Bunny before the primary request; when it comes back, Qwen is
eligible again after the five-second health cache expires. This checks provider
endpoint health, not whether a particular model is loaded by NInfer.

From this directory, run:

```sh
opencode api get /api/agent
```

Inspect the response's `data[]` entries with IDs `quartermaster-test` and `qm-test`; their `model` fields show the agent transform's assignments. Their modes must be `subagent` and `primary`, respectively. This API inspection sends no inference request. Both deny all tools: they can reply in chat but cannot use tools or edit files. In OpenChamber, only `qm-test` belongs in the primary-agent selector.

Only with authorization to use the configured providers, invoke the primary agent from this directory:

```sh
opencode run --agent qm-test "Reply with a short acknowledgment."
```

In either host, inspect `/api/agent` to see the assigned model rather than asking the model to guess its own ID. That only verifies assignment; it does not prove which model served a request.

To invoke `quartermaster-test` in OpenCode or OpenChamber, open this example project with a parent primary agent whose permissions allow launching that subagent, then ask:

```text
Use the quartermaster-test subagent to reply with a short acknowledgment without calling tools.
```

This can spend both parent and child inference; obtain provider-use authorization first. Do not use `qm-test` as the parent: its deny-all permissions prohibit delegation. The subagent runs in a child session, not the primary selector. Inspect the child's stored agent/model and actual provider request logs for serving identity; a reply or catalog label is not request proof.

## Diagnose project setup

Run the API checks from `examples/test-agent`, so they inspect this project's
agent catalog and plugin configuration. If either test agent is missing from `/api/agent`,
fix project discovery or agent configuration before testing routing; do not add
an agent or binding as a diagnostic shortcut. Check `/api/plugin` and
`/api/command` in the same project for the `quartermaster` plugin and its
`qm-auto`/`qm-manual` commands. A missing plugin or RPC is a setup failure;
`status: "unconfigured"` with empty sources is different: Quartermaster loaded,
but no usage source is configured for Quartermaster in this project. The separate
`opencode-usage.status` RPC publishes the source IDs `go`, `codex`, and `cursor`;
its cached provider status can be healthy while Quartermaster remains
unconfigured until this project's `usageSources` map selects them.

If a test agent exists but explanation returns `no-plan`, compare its agent binding
and plan names in this project's Quartermaster options. Project options replace
the host/global Quartermaster options rather than merging key-by-key: this
example binds both `qm-test` and `quartermaster-test` to `test-agent`, while the repository root binds
`reviewer` to `review`. Bound agents route automatically by default. Use
`/qm-manual` before deliberate model or variant changes; use `/qm-auto` to
resume routing. The stock host does not reliably expose same-model reselection
provenance, so an inherited or pre-first-prompt choice may be replaced. The
loopback fixtures do not prove native OpenChamber UI display or queued-turn behavior.

## Verify routing without external inference

From the repository root, run `node --test test/integration/test-agent.test.ts`. It checks both definitions, their exact bindings and deny-all permissions, then simulates primary -> backup -> recovered-primary assignments for each agent. It also checks unbound behavior and eligible pins. Session-level `/qm-manual` preservation is covered by `test/agent-routing.test.ts`; synthetic assignments are not live provider or child-session proof.

From the repository root, run the tracked admission check:

```sh
node scripts/verify-admission-host-contract.mjs
```

It uses a private OpenCode 2.0.25 server and loopback fake providers to start a bound session on an out-of-plan default and verify that the first primary request uses the Quartermaster model without an opt-in command. It forks that session and repeats the admission check for a bound child session. A separate `/qm-manual` session verifies the host model is preserved. It then marks the planned local provider unhealthy and verifies the automatically routed prompt is rejected with no primary request to the displaced default. It sends no external inference. This proves the stock OpenCode server hook path, not the authenticated OpenChamber UI, queued turns, or global configuration.

The same check verifies `/qm-status` queues its diagnostic without waking execution, and `quartermaster.diagnoseSession` returns immediate output without queuing, changing the model, probing health or sending any provider request. Stock command output stays in the inbox until later normal delivery; it is not immediate visible chat output. Initial cached diagnostics can report `not-in-registry` before provider registration; the fixture also verifies the recommendation after normal admission refreshes that cache. Actual OpenChamber command/UI proof remains separate.

For same-prompt retry routing, run:

```sh
node scripts/verify-retry-host-contract.mjs
```

It requires the installed OpenCode **2.0.24** binary, starts a loopback-only fake provider, loads this checkout's Quartermaster plugin, and asserts the actual request sequence `primary → primary → fallback` in one run. It also checks the native retry delay, identical user message, bounded primary attempts, and absence of tool calls. It sends no request to Qwen or Space Bunny.

To verify the host's retry ceiling when every candidate fails, also run:

```sh
node scripts/verify-retry-host-contract.mjs --exhausted
```

This expected-failure case asserts OpenCode exits after exactly 12 provider attempts (`primary → primary → fallback` ten times), with no new prompt or tool calls. The script itself exits successfully only when that bounded failure is observed; it contacts only the loopback fake provider.

## Optional live `qm-test` smoke

Only run this if you are authorized to use both configured providers. It can send inference to Qwen and Space Bunny. From this directory, first confirm `/api/agent` assigns `ninfer/qwen3.8-27b`, then run:

```sh
opencode run --print-logs --log-level debug --agent qm-test "Reply with a short acknowledgment."
```

If your NInfer service exposes request logs, inspect them along with OpenCode's logs to verify the actual provider/model requests; do not infer them from the agent catalog or answer text. To exercise failover, stop the NInfer endpoint while leaving its model enabled in the catalog, then submit one prompt and inspect whether OpenCode reports a retry and whether the same run reaches Space Bunny. Stopping the endpoint tests a provider failure; it does not disable Qwen or force the host to retry. Restore the endpoint afterward and allow its health/cooldown state to recover before testing Qwen again.

Disabling `providers.ninfer.models["qwen3.8-27b"].disabled` in this isolated `opencode.json` is a different test: it removes Qwen from eligibility, so Quartermaster may assign Space Bunny immediately and there is no failed-primary retry to observe. Restore the field to `false` or remove it after that check. These edits affect only this example, never global config.

## Retry boundaries

The controlled host proof establishes fallback for an OpenCode-approved clean retry before any response output. Quartermaster correlates the retry to a primary model request, records a cooldown for the failed model on HTTP 429, for the provider on HTTP 5xx, and otherwise for the failed model; it does not change OpenCode's retry decision, delay, or attempt limit. If no eligible unattempted plan candidate exists, it leaves the current host retry alone. A fallback that also fails is not cycled back to an already attempted model; OpenCode ultimately reports the failure when its native retries end. Cooldowns and model availability affect later executions, so after recovery a later prompt can select Qwen again.

OpenCode's partial-output continuation is distinct from a clean retry and is not switched mid-response. This does not roll back emitted text or guarantee exactly-once tool execution. Other plugins may also observe or modify retry decisions; Quartermaster only routes when the decision is still retryable when its hook runs, and hook ordering with other decision-changing plugins is not guaranteed by this smoke test. The automated unit/integration tests cover cancellation/denial, auxiliary and unbound routing boundaries, exhausted candidates, exclusive concurrency, switch failures, and recovery; label those as simulated tests, not live-provider evidence.
