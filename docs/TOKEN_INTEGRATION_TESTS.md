# Token integration verification

Run from the Quartermaster checkout:

```sh
node --test test/integration/token-report.test.ts
npm test
npm run typecheck
```

The integration test is synthetic: it sends duplicate terminal host-event
fixtures through `consumeTokenEvents`, persists them in the project-partitioned
ledger, and reads them through the registered reporting RPC. Its assertions
check event-ID upsert behavior, project isolation, lower-bound totals, retry
timestamps, incomplete budget semantics, and that the RPC response omits host
event IDs. Other telemetry tests cover unknown project/model attribution,
retention/restart, concurrent writes, malformed requests, and absent RPC.

## Live-host status

No isolated live-host reconciliation is claimed. To collect that evidence
safely, use a disposable OpenCode server with two test projects and synthetic
or already-available sessions; do not exhaust quotas, invoke provider APIs for
telemetry, or use production data. Record the host version, project/session
fixture, observed terminal messages, ledger rows and RPC output; compare only
evidenced counts and preserve unknown dimensions. Repeat after plugin restart
and an absent-report-service case. Keep the resulting artifacts free of
prompts, credentials, raw errors and session/message IDs.

## Known limits

- The live event stream has no cursor/replay recovery; missed events remain
  missing and report totals are incomplete lower bounds.
- The collector does not infer a step's provider/model from the current
  session model. Direct calls and unattributed sessions remain unknown.
- Retry errors are best-effort observations with local timestamps; there is no
  durable host request ID for replay deduplication. Only verified session
  project attribution is included in project reports.
- Budget reports never claim a hard cap or known remaining capacity.
- The RPC is scoped to its active project context; the handler has no caller
  identity for cross-project authorization.
