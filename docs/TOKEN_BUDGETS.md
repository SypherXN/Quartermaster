# Token budgets

Budgets are opt-in Quartermaster configuration for warnings about observed
token usage over rolling or calendar windows. They do not filter or reorder
models, enforce a hard cap, or switch the active session model.

These examples are the contents of `quartermaster.jsonc`, not an OpenCode plugin entry and not a complete OpenCode configuration file. Merge them into the existing settings file. Do not put them in `plugins[].options`.

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
`limitTokens`, and exactly one window. `mode` is optional and defaults to
`advisory`; `strict` is accepted as a request but does not enable enforcement.

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

Current telemetry can associate some events with a host project, but the
collector cannot reliably link provider/model identity to each step. It also
has no verified plugin ownership: stored self-reported plugin claims are for
reporting only and never count toward budgets. Project is the only currently
supported budget dimension when its project ID is known. Provider/model/plugin
targets are accepted configuration, not attribution evidence. Unknown project
IDs likewise remain unknown. The live
event stream has no replay/completeness watermark, so readings always report
`complete: false`.
`remainingTokens` is always `null`; `limitReached` is true only when the
observed lower bound alone reaches the configured limit. Do not present these
readings as complete usage or remaining capacity.

## Assignment warnings

At Quartermaster-owned agent assignment boundaries, advisory budgets log
structured `budget-limit-reached` reasons when observed usage alone reaches a
limit, and `budget-usage-unknown` when in-window records cannot be attributed
or counted. Known usage below the limit does not produce a warning. These
reasons accompany normal candidate selection; they never exclude a candidate,
change plan order, or alter quota, pin, or explicit-choice precedence.

A `strict` budget reports `cannot-guarantee-hard-cap` instead of claiming
enforcement. The event stream has no trustworthy request bound or complete
replay watermark, and concurrent assignments cannot reserve future token
usage atomically. Unknown or late-arriving usage can therefore make the
observed total incomplete. New telemetry may refresh warnings for subsequent
assignments, but cannot affect an active session or retroactively guarantee a
cap. Consumer-plugin requests are outside this Quartermaster-owned warning
boundary.

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

Plugin budgets are also accepted but unsupported: self-reported plugin claims
do not establish verified ownership, so their usage remains unknown. A
configured target does not make its dimension attributable.

With no `budgets` configured, evaluation returns no readings and routing is
unchanged. Invalid dimensions, targets, duplicate IDs, non-positive windows,
and non-positive limits are rejected during config parsing. See
[`TOKEN_TELEMETRY.md`](TOKEN_TELEMETRY.md) for collection and retention limits.
