# Quartermaster test agent

This isolated OpenCode project loads the local Quartermaster package and a read-only primary agent, `qm-test`. Quartermaster routes it through `ninfer/qwen3.8-27b` first, then `opencode/space-bunny-free`.

From this directory, run:

```sh
opencode api get /api/agent
```

Inspect the response's `data[]` entry with `id: "qm-test"`; its `model` field is the model assigned by the loaded agent transform. This API inspection sends no inference request. In OpenChamber, open this same example project and select `qm-test` in the primary-agent selector. Its deny-all tool permissions keep it read-only; it can reply in chat but cannot use tools or edit files.

To invoke it from OpenCode, run this from the example directory:

```sh
opencode run --agent qm-test "Reply with a short acknowledgment."
```

In either host, inspect `/api/agent` to see the assigned model rather than asking the model to guess its own ID. That only verifies assignment; it does not prove which model served a request.

## Verify routing without external inference

From the repository root, run the tracked host check:

```sh
node scripts/verify-retry-host-contract.mjs
```

It requires the installed OpenCode **2.0.23** binary, starts a loopback-only fake provider, loads this checkout's Quartermaster plugin, and asserts the actual request sequence `primary → primary → fallback` in one run. It also checks the native retry delay, identical user message, bounded primary attempts, and absence of tool calls. It sends no request to Qwen or Space Bunny.

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
