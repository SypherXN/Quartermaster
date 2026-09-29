# Token budgets

Budgets are opt-in Quartermaster configuration for reporting observed token
usage over rolling or calendar windows. They do not change routing or switch
the active session model.

```json
{
  "budgets": [
    {
      "id": "project-month",
      "dimension": "project",
      "limitTokens": 1000000,
      "calendarWindow": { "unit": "month", "timeZone": "UTC" }
    }
  ]
}
```

Each budget needs a unique `id`, a `dimension`, a positive integer
`limitTokens`, and exactly one window:

- `windowMs`: a positive integer rolling duration in milliseconds.
- `calendarWindow`: `{ "unit": "day" | "week" | "month", "timeZone": "…" }`.
  Timezone defaults to `UTC`; weeks start on Monday.

`project` applies to the current host project and takes no `target`. `provider`,
`model`, and `plugin` require a target; model targets use
`providerID/modelID`.

Configure multiple budgets as separate entries. They are evaluated
independently, not added together, even when their windows or dimensions
overlap.

## Evidence and unknown attribution

The evaluator uses the rolling interval `[now - windowMs, now]` or the current
timezone-aware calendar period, including its start boundary. Its
`observedTokens` is a lower bound calculated as `input + output`; reasoning is
already part of output, while cache read/write counts are breakdowns and are
not added a second time. A known row counts only when its dimension matches
exactly. Rows that could belong to the budget but lack required attribution,
or have missing counts, increment `unknownRecords` instead of being guessed
into or out of the total.

Current telemetry can associate some events with a host project, but provider
and model ownership is not reliably linked to each request, and plugin
ownership is not recorded. Project is the only currently supported budget
dimension when its project ID is known. Provider/model/plugin dimensions are
accepted for forward-compatible configuration but are currently unverified;
their ownership stays unknown, and a configured target does not create
attribution evidence. Unknown project IDs likewise remain unknown. The live
event stream has no replay/completeness watermark, so readings always report
`complete: false`.
`remainingTokens` is always `null`; `limitReached` is true only when the
observed lower bound alone reaches the configured limit. Do not present these
readings as complete usage or remaining capacity.

Project is usable when the host session lookup supplies a project ID. A model
budget is valid configuration, but is meaningful only for records with exact
per-step provider/model correlation; the current collector leaves those IDs
unknown, so this example currently reports unknown attribution rather than a
model total:

```json
{
  "budgets": [
    {
      "id": "project-month",
      "dimension": "project",
      "limitTokens": 1000000,
      "calendarWindow": { "unit": "month", "timeZone": "UTC" }
    },
    {
      "id": "quality-model-month",
      "dimension": "model",
      "target": "provider-a/quality-model",
      "limitTokens": 200000,
      "calendarWindow": { "unit": "month", "timeZone": "UTC" }
    }
  ]
}
```

Plugin budgets are also accepted by the parser but unsupported by current
telemetry because plugin ownership is not recorded; their usage remains
unknown. Do not interpret either configured target as evidence that its
dimension is currently attributable.

With no `budgets` configured, evaluation returns no readings and routing is
unchanged. Invalid dimensions, targets, duplicate IDs, non-positive windows,
and non-positive limits are rejected during config parsing. See
[`TOKEN_TELEMETRY.md`](TOKEN_TELEMETRY.md) for collection and retention limits.
