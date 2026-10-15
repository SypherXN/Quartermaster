# Token telemetry contract

This defines Quartermaster's metadata ledger, live event collectors, and
project-scoped V2 reporting method. It is not a claim of complete provider
billing or complete event capture.

## Verified host contract

The manifest pins `@opencode/plugin` and `@opencode/client` to **2.0.23**.
The lockfile also resolves `@opencode/schema` to **2.0.23**. This records
the locked schema, not a runtime host version gate; reverify upgrades. The upstream
event/server source links below were reviewed against OpenCode tag
[`v2.0.18`](https://github.com/anomalyco/opencode/tree/v2.0.18) and are retained
as historical source references, not a claim that the current host runs that tag.
Telemetry tests use the locked 2.0.23 types and synthetic events. The cited source
commit is [`cd9a14a6b688d4021bee381dfd39d2cef9c0f862`](https://github.com/anomalyco/opencode/commit/cd9a14a6b688d4021bee381dfd39d2cef9c0f862):

- [`session-event.ts`](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/schema/src/session-event.ts)
  defines step, retry, and compaction events.
- [`event.ts`](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/schema/src/event.ts)
  defines the V2 envelope (ID, creation time, type, optional durable sequence,
  location, and data).
- [`session-message.ts`](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/schema/src/session-message.ts)
  and [`session.ts`](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/schema/src/session.ts)
  define assistant-message and session metadata.
- [`event.ts` server handler](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/server/src/handlers/event.ts)
  exposes the event subscription as SSE; the endpoint contract is defined by
  [`groups/event.ts`](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/protocol/src/groups/event.ts).

The plugin API is `Context.event.subscribe(): AsyncIterable<V2Event>`. In this
schema, `created` is the event timestamp in milliseconds. `session.step.ended`
contains `assistantMessageID`, `sessionID`, and all five token counts: input,
output, reasoning, cache read, and cache write. `session.step.failed` may have
the same token object, but it is optional. Explicit zero is reported usage;
absent or incomplete counts are **missing**, never zero-filled.

## Projection rules

`src/telemetry/types.ts` projects only terminal step events into a whitelisted
record. Stable identity is the host event ID; repeated delivery within one
batch yields one record. Different step IDs remain separate even when they
share a message ID. The ledger below keeps one row per host event ID across
plugin restarts, within its retention limits.

- Count a complete step token object once. Failed steps without counts remain
  `counts: null` and `usageStatus: "missing"`.
- Ignore started/streamed events, retry markers, message updates, session
  aggregates, and compaction events. A retry marker is not a provider response.
  The v2.0.18 source reviewed for this contract repeats usage on compaction
  completion; excluding it avoids mixing it with step records. Verify this
  behavior against the host source when upgrading the locked version.
  Compaction-only usage remains a coverage gap pending an unambiguous source.
- Assistant message token snapshots are not the accounting unit: OpenCode
  overwrites the snapshot on each provider step, while one logical message may
  contain multiple steps. Never sum snapshots or deduplicate by message ID.
- Step-ended has no model reference. Provider/model/variant stay null unless a
  caller can correlate the model to that exact step; a session's last model or
  message's final model is insufficient evidence. The collector looks up the
  exact assistant message by matching `assistantMessageID` to
  `SessionMessageInfo.id` and retains only its `agent` ID, never its content. If
  that message is absent from active context, agent attribution stays unknown.
- Provider is a first-class token reporting dimension, not a fallback inferred
  from the model name. Each token record carries `providerID`; it is `null`
  whenever the exact provider for that step cannot be established. The exact
  message lookup establishes agent only; it does not correlate model selection
  or configured plan to a terminal step.
- Events carry session ID, not project or parent IDs. Resolve `projectID` and
  optional `parentID` from `Session.Info`. Its location contains a directory
  and optional workspace ID; the record omits the absolute path. Event location
  is optional and does not replace session metadata.
- The record never copies prompts, content, errors, permissions, provider
  state, snapshots, file lists, credentials, costs, or arbitrary event fields.
  `opencode-usage.json` quota percentages are not token counts.

`hostContractVersion`, `sourceEvent`, and `hostEventID` identify the contract
and provenance. `usageStatus` distinguishes valid zeros from missing data.

## Local ledger

`src/telemetry/collector.ts` subscribes to the live host event stream and is
disposed with the plugin. It resolves project and parent IDs from session
metadata; if that lookup fails, it still stores the usage with unknown
attribution. It does not infer the model from the session's current model.
Failed storage writes are retried once using the same host event ID. A later
delivery or revised record upserts the row rather than adding token counts.

`src/telemetry/ledger.ts` stores one whitelisted record per host event ID in
the plugin-scoped host KV. The KV is shared across this plugin's project
contexts; each row retains its own project ID, including `null` for unknown,
so a project query filters rather than relabels rows. Rows expire after 90
days. Retention keeps at most 10,000 rows per project partition (the unknown
project partition has its own cap); in-process list/export queries return at
most 10,000 rows, in completion-time order. This is a per-project ceiling, not a
single global storage ceiling. Expired/over-cap pruning is intentionally
partitioned so activity in one project does not evict another project's
unexpired rows.

The host KV upserts each key atomically, but exposes no multi-key transaction,
compare-and-swap, or cross-instance lock. Distinct host event IDs therefore
write independent rows; concurrent updates to the same ID are last-write-wins
without a guaranteed revision ordering, and pruning is not a cross-key atomic
snapshot. The collector does not claim stronger cross-instance serialization.
The ledger is internal plugin storage; project reports are exposed only through
the plugin's V2 RPC.

## Provider error observations

`src/telemetry/errors.ts` observes OpenCode's V2 [`session.retry` hook](https://opencode.ai/v2/docs/build/plugins/effect)
(the locked `@opencode/plugin` session-hook contract). The hook exposes the exact
attempt's session, provider/model, attempt number, error status/type/message,
and retry decision. Quartermaster does not modify that decision. It stores
`Date.now()` as `observedAt` because the hook supplies no event timestamp. It
stores provider/model, attempt, HTTP status, normalized classification,
session project ID only when exact `Session.Info` lookup succeeds, source, and
a locally generated ID. It does not store the error type/message, session ID,
prompt, response body, credentials, or permission data. Failed lookups and
legacy rows remain unattributed (`projectID: null`) and are excluded from
project reports.

HTTP 429 is classified as `rate-limit`; other 4xx statuses as `request-error`,
5xx as `provider-error`, and absent/invalid status as `unknown`. This is a
best-effort history of failures observed by the retry hook, not a complete
record of all server/provider errors or a substitute for quota status. The hook
has no host event/request ID or durable replay; the local UUID distinguishes
stored callback observations but cannot deduplicate a host replay. A failed KV
write is logged without error content and is not retried. The separate error
ledger keeps up to 10,000 rows for 90 days and supports bounded time/provider/
model filtering; it does not change routing cooldown behavior.

## Reporting RPC

The `report` method and `requestReport` helper use Quartermaster API version 1
on OpenCode V2; this is not the legacy OpenCode V1 API. They return a bounded
project report. The project is always the plugin's active host project context;
the caller cannot supply ownership. Requesting a different `projectID` returns
`unsupported` (`cross-project-authorization-unavailable`). The V2 plugin RPC
context exposes no caller identity that Quartermaster could use to authorize
cross-project access, so no such access is claimed.

The report includes project totals and provider/model/agent breakdown pages (up to
100 items per page, offset capped at 10,000), optional inclusive `since` and
`until` millisecond timestamps, configured budget-window readings, and
timestamped retry-error summaries grouped by classification. Unknown provider
or model is an explicit `null` dimension. Agent is reported only from the exact
assistant message matched by `assistantMessageID`; missing messages remain
unknown and evidence is marked incomplete. Plan attribution is explicitly
unsupported (`no-exact-plan-step-link`) for every record: agent names, current
bindings, work-type choices, pins and later config cannot prove the historical
plan for that step. Error rows without verified
session-to-project attribution are omitted and `unattributedExcluded` is true;
error counts are retained observations, not a complete history.
Budget windows use all retained project rows, not the report's since/until
filter; observed usage is a lower bound, `complete` is false, and remaining
tokens are unknown.

`generatedAt` describes read time; `latestObservedAt` describes the latest
matching token event. Live events have no cursor/replay, so freshness does not
prove completeness. `refresh: true` only rereads the durable local ledgers; it
does not poll providers, trigger ingestion, or recover missed events. Reports
do not expose session/message IDs, prompt contents, or raw errors.

Configured `tokenRates` add a partial `costs` estimate. Rates match the exact
provider/model/variant tuple and include input/output price per million tokens,
currency, source and `asOf` timestamp. Only records with that exact model and
both input/output counts are priced. Amounts use input plus output only;
reasoning/cache component fields may overlap and are excluded. Results are
grouped by currency without conversion, marked `estimated-not-billed` and
`complete: false`, and include priced/unpriced record and token coverage plus
unknown-count records. Missing model evidence, rate or counts stays unpriced;
records that would overflow the safe-integer priced subtotal also stay unpriced.
Unpriced token totals exclude records that would overflow their safe-integer
subtotal and count those records in `unknownTokenRecords`. Coverage totals are
therefore lower bounds, not rounded representations of oversized totals;
these estimates are not invoices and do not change budgets, selection or
provider polling. Rates are current user-configured values, so the report's
`asOf` metadata does not reconstruct historical provider pricing.

### Opt-in plugin attribution

Cooperating plugins may opt in through the API-version-1 `reportPluginUsage` RPC
and submit a stable self-reported `pluginID`, display `pluginName`, and 1–100
host `sessionIDs` (include child sessions when applicable):

```ts
await ctx.rpc(QUARTERMASTER_RPC).reportPluginUsage({
  pluginID: "com.example.review",
  pluginName: "Review plugin",
  sessionIDs: [parentSessionID, childSessionID],
})
```

Quartermaster binds each claim to the active project context; the caller cannot
choose a project. The RPC has no caller identity, so claims are
**self-reported and unverified**, not
proof that the named plugin owned the sessions. Only an exact session-ID match
to a token record whose host-observed project matches the active project can
appear in a plugin dimension. Missing, unmatched, unknown-project, cross-project
and ambiguous claims remain unknown. Multiple distinct plugin identities
claiming the same session make its records ambiguous. Reports aggregate labels
and counts without returning session IDs.

Claims are opt-in and retained for at most 90 days / 10,000 claims per project;
repeating the same project/plugin/session claim is idempotent. Plugin labels
never change evidence-based provider/model fields, budget readings, eligibility,
routing, active sessions, or authorization. Do not use them to justify
cross-project access or a hard budget cap. The host event stream is incomplete,
so a claim may outlive or fail to match the token observations Quartermaster
received; unobserved usage stays unknown. Attribution report fields explicitly
use `self-reported-unverified`, `verified: false`, and `complete: false`.

## Completeness limits

The event subscription is live SSE without a cursor/replay parameter; events
may be missed on disconnect or slow-consumer overflow. Durable sequence
metadata and event-ID dedup reject repeats but cannot recover gaps. The local
ledger is durable for records it receives, but cannot promise a complete
ledger. Auxiliary calls without attributable step events are not claimed, and
session aggregates do not fill gaps. Exports preserve `counts: null` and
`usageStatus: "missing"`; absence is never treated as zero.
