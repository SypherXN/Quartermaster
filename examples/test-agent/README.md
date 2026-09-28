# Quartermaster test agent

This isolated OpenCode project loads the local Quartermaster package and a read-only `quartermaster-test` subagent. Its two candidate IDs are synthetic placeholders; replace them in `opencode.json` with two enabled `providerID/modelID` values from `opencode models` before checking a real host selection.

From this directory, run:

```sh
opencode api get /api/agent
```

Inspect the response's `data[]` entry with `id: "quartermaster-test"`; its `model` field is the model assigned by the loaded agent transform. This API inspection sends no inference request. In OpenChamber, open this same example project to expose the subagent. Invoking it via a parent agent sends a model request and may use provider quota.

To invoke it from OpenCode after replacing the fixture model IDs, run this from the example directory:

```sh
opencode run --agent build "Ask the quartermaster-test subagent to reply with a short acknowledgment."
```

In OpenChamber, open the same directory and ask the selected primary agent to launch `quartermaster-test` once. In either host, inspect `/api/agent` to see the actual configured model rather than asking the model to guess its own ID.

The repeatable primary → backup → recovered-primary cycle is synthetic and runs with `npm test` from the repository root. The checked-in fixture is not wired into the live plugin's availability state. It neither changes host quota nor claims end-to-end provider failover; that requires the later usage integration.
