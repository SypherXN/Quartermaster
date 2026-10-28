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
- Ignore streamed events, retry markers, message updates, and session
  aggregates. A retry marker is not a provider response. `session.step.started`
  is observed only to pair that step's own model with its terminal event; it
  never becomes a record.
- Keep `session.compaction.ended` and `session.compaction.failed` out of step
  records. Their own token object is stored in a separate compaction ledger and
  grouped by the model on that event. Those tokens are not added to observed
  session totals, cost, or budgets. A missing token object is stored as missing.
- Assistant message token snapshots are not the accounting unit: OpenCode
  overwrites the snapshot on each provider step, while one logical message may
  contain multiple steps. Never sum snapshots or deduplicate by message ID.
- Step-ended carries no model reference, but `session.step.started` names the
  model for that same step. `src/telemetry/step-model.ts` keeps the start events
  per assistant message and pairs them in order with the terminal events, so a
  step's provider/model/variant come from its own start event. A session's last
  model, a message's final model, and a configured plan are still not evidence
  and are never substituted. An unpaired terminal step keeps null model fields.
  The collector also looks up the exact assistant message by matching
  `assistantMessageID` to `SessionMessageInfo.id` and retains only its `agent`
  ID, never its content. If that message is absent from active context, agent
  attribution stays unknown.
- Provider is a first-class token reporting dimension, not a fallback inferred
  from the model name. Each token record carries `providerID`; it is `null`
  whenever the exact provider for that step cannot be established.
- Events carry session ID, not project or parent IDs. Resolve `projectID` and
  optional `parentID` from `Session.Info`. Its location contains a directory
  and optional workspace ID; the record omits the absolute path. Event location
  is optional and does not replace session metadata.
- The record never copies prompts, content, errors, permissions, provider
  state, snapshots, file lists, credentials, or arbitrary event fields. Only the
  host's own `Money.USD` step cost is kept, as `hostCostUSD`; a missing or
  negative figure is stored as `null`, never zero.
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

`src/telemetry/window.ts` keeps one character snapshot per host session, in its
own `quartermaster:window:v1:` keyspace with the same 90-day, 10,000-per-project
limits. It stores only four integer character counts and the observation time:
no text, parts, or file bytes cross into the ledger. A snapshot replaces the
previous one for that session.

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
stores provider/model, attempt, HTTP status, a classification derived from that status alone,
session project ID only when exact `Session.Info` lookup succeeds, source, and
a locally generated ID. It does not store the error type/message, session ID,
prompt, response body, credentials, or permission data. Failed lookups and
legacy rows remain unattributed (`projectID: null`) and are excluded from
project reports.

HTTP 429 is classified as `rate-limit`; other 4xx statuses as `request-error`,
5xx as `provider-error`, and an absent or invalid status, or any status below 400, as `unknown`. Classification reads only that HTTP status, so an error that routing itself treats as a rate limit from its type or message text, with no status present, is stored here as `unknown` with a null status. This is a
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
unknown and evidence is marked incomplete. Plan attribution matches each
record's exact provider/model/variant against the configured plans: a record
listed by exactly one plan is attributed to it (`model-match-unique`), a record
no plan lists is unknown, and one listed by several plans is ambiguous. A step
records no plan identity, so this reflects which plans list that model now;
agent names, work-type choices, pins and later config cannot prove the
historical choice. Error rows without verified
session-to-project attribution are omitted and `unattributedExcluded` is true;
error counts are retained observations, not a complete history.
Budget windows read the most recent project rows (up to 10,000 on the report path; the assignment-warning gate reads only the newest 1,000), not the report's since/until
filter; observed usage is a lower bound, `complete` is false, and remaining
tokens are unknown.

`generatedAt` describes read time; `latestObservedAt` describes the latest
matching token event. Live events have no cursor/replay, so freshness does not
prove completeness. `refresh: true` only rereads the durable local ledgers; it
does not poll providers, trigger ingestion, or recover missed events. Reports
do not expose session/message IDs, prompt contents, or raw errors. Session rows
carry a short hash of the root session id, so repeated observations group
together without publishing the identifier.

Configured `tokenRates` add a partial `costs` estimate. Rates match the exact
provider/model/variant tuple and include input/output price per million tokens,
currency, source and `asOf` timestamp. A record with no configured rate is
priced from the model catalog instead: USD per million tokens, cheapest matching
context tier at or below the record's input plus cache-read tokens, covering
input, output, cache read and cache write. Reasoning stays out of the amount
because the catalog does not price it, and each currency summary records whether
it used `config`, `catalog` or both. Records with neither price stay unpriced;
a configured rate prices no cache tokens, so such records increment
`cacheUnpricedRecords`. Results are
grouped by currency without conversion, marked `estimated-not-billed` and
`complete: false`, and include priced/unpriced record and token coverage plus
unknown-count records. A separate `hostReported` block carries the host's own
`Money.USD` step total: `currency: "USD"`, `amount` (null when no step reported
one), and the reported and missing step counts. It is not added to the catalog
estimate and does not change budgets; UI cost readings prefer it over the
estimate.
Missing model evidence, price or counts stays unpriced;
records that would overflow the safe-integer priced subtotal also stay unpriced.
Unpriced token totals exclude records that would overflow their safe-integer
subtotal and count those records in `unknownTokenRecords`. Coverage totals are
therefore lower bounds, not rounded representations of oversized totals;
these estimates are not invoices and do not change budgets, selection or
provider polling. Rates are current user-configured values, so the report's
`asOf` metadata does not reconstruct historical provider pricing.

### Totals, retention and archived usage

`observedTokens` remains `input + output`. Reasoning is part of output and cache
counts are part of input, so totals also report `input`, `output`, `cacheRead`,
`cacheWrite` and `reasoning` beside it instead of adding them again.
`partialTokenRecords` counts records whose reasoning or cache fields were absent
and were defaulted to zero. `range` echoes the applied `since`/`until` and states
that budgets are evaluated over all history, not the report range.

Raw records are retained for 90 days and up to 10,000 per project. Records
pruned by age or by that cap are folded into per-day rollups with their record,
observed-token and unknown-token counts. The report's `archived` block reports
those rollups, and totals include them; dimensions, plan/plugin/agent
attribution and the breakdown page stay raw-only and therefore cover the
retained window. Records pruned before rollups existed are not recovered, and a
rollup keeps counts only, never model, agent or plugin detail.

`sessions` lists one row per root session with its child sessions rolled in: the
session and message counts, records, observed tokens and the same
input/output/cache/reasoning split, the last observed step, that step's model,
and its prompt size (`lastInputTokens` = input + cache read) against the
catalog's context limit. `contextPercent` is null when either value is unknown,
so an unknown limit never renders as a full window. `hostCostUSD` sums the
root's own reported step costs and `hostCostMissing` counts its steps with no
host cost; both stay out of the catalog estimate, totals, and budgets. A step
with no figure increments `hostCostMissing` and is not stored as zero. When
that count is above zero the row is unknown for display and for ordering.
`hostCostUSD` stays null when no step reported a figure. `cacheHitRate` is
`cacheRead / (cacheRead + cacheWrite)` for that root. It is null when the root
has no cache tokens or any step left a cache count unknown, and those counts
stay out of `observedTokens`. `cacheWriteAfterCompaction` is the cache-write
tokens on the first write after a host compaction in that same session;
`cacheWriteOther` is every other cache write. The join uses the compaction
row's session hash, and a write at the same timestamp is not after the
compaction. No other miss cause is named. `childTokenShare` and
`childHostCostShare` are the child sessions' share of that root. Either is null
when its denominator is unknown or zero, and a missing host cost is not treated
as zero. `window` is the latest character snapshot of that root's context, taken
from `Context.session.context()` at a terminal step, split into `user`,
`assistant`, `tool`, and `other`. It is a character length, not a token count,
and is never added to `observedTokens`. A root with no snapshot keeps
`window: null`. Rows are ordered by host-reported USD, highest first. A root
with any missing step cost sorts after every fully priced root, then by observed
tokens. The row key is a short hash of the root session id.

`compaction` is the summarizer's own call, grouped by the provider, model and
variant on `session.compaction.ended` or `session.compaction.failed`.
`includedInTotals` is false. `lastInputTokens` is that call's input plus cache
read, and `contextLimit` is the catalog window of the model that ran the
summary, not the chat model's window. `contextPercent` is null when either
value is unknown. The block is filtered by the report range, kept for 90 days
and 10,000 rows per project, and is not folded into daily rollups.

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

### Direct calls a plugin reports itself

A call that never becomes a host step, such as OPR asking Jev directly, is absent
from the session ledger. The same plugin can submit that call's own counts with
`reportDirectUsage`. The project is the active project; the caller cannot choose
another. `usageID` is the caller's idempotency key: the same plugin and usage id
replaces the earlier row and keeps the first reported time. It is stored, not
returned in the report.

```ts
await ctx.rpc(QUARTERMASTER_RPC).reportDirectUsage({
  pluginID: "opr",
  pluginName: "OPR",
  usageID: "review-jev-01",
  providerID: "jev",
  modelID: "review",
  counts: { input: 1200, output: 80, cacheRead: 400 },
})
```

`input` and `output` are required non-negative integers. `reasoning`,
`cacheRead`, and `cacheWrite` are optional; a missing one becomes zero and marks
the row partial. The report's `directUsage` block groups those rows by plugin
and model. It is self-reported and unverified, kept out of host totals, session
rows, plan attribution, cost, and budgets, so a plugin cannot add to the
observed ledger by claiming a number. Rows last 90 days, at most 10,000 per
project. A host restart is required before a running OpenCode process exposes
the method.

## Completeness limits

The event subscription is live SSE without a cursor/replay parameter; events
may be missed on disconnect or slow-consumer overflow. Durable sequence
metadata and event-ID dedup reject repeats but cannot recover gaps. The local
ledger is durable for records it receives, but cannot promise a complete
ledger. Auxiliary calls without attributable step events are not claimed, and
session aggregates do not fill gaps. Exports preserve `counts: null` and
`usageStatus: "missing"`; absence is never treated as zero.
