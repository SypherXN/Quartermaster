# Provider strategy: spending every reset window well

A plan answers "which model". A category answers "which of these interchangeable
models", and `pick` answers "in what order". This document is about the order:
how to spend a set of providers whose limits reset on their own clocks.

## A provider's allowance is several windows at once

Every source reports named windows, and a request is charged to **all** of
them simultaneously. A typical account looks like this:

| provider | rolling | weekly | monthly |
| --- | --- | --- | --- |
| `opencode-go` | 5h | 7d | ~30d |
| `openai` (codex) | `primary_5h` | `secondary_7d` | — |
| `claude-agent` | 5h | 7d | — |

Two consequences drive everything else:

1. **Usable headroom is the smallest window, not the one you are looking at.**
   A provider at 10% of its rolling window and 95% of its weekly window has 5%
   of room. The weekly window is the *binding* constraint.
2. **Refilling a short window does not lower the long one.** When the 5h window
   resets, the weekly number stays where it was. Draining the 5h window is
   therefore free, and draining the weekly window is not.

So a provider at any moment is in one of three regimes.

| regime | signature | what to do |
| --- | --- | --- |
| capped | a window is at 100%, or reports `rate-limited` | unusable until its `resetsAt`; nothing to decide |
| draining | binding window high, `resetsAt` soon | use it first: the room you leave is lost, and the cap lifts shortly |
| fresh | binding window low for the time remaining | use it later; spending now buys nothing and risks nothing |

"Reset soon" alone is not urgency. A bucket that resets in 10 minutes and is 2%
used has nothing worth salvaging; a bucket that resets in 10 minutes and is 95%
used does.

## What `pick.by: "reset-soonest"` does today

Ordering inside a category, ascending:

1. the window whose `resetsAt` is soonest;
2. tie: the window with the higher `usedPercent`;
3. tie: `pick.path` order (provider IDs, most preferred first);
4. tie: the order the file lists them;
5. a provider with no fresh clock sorts after every provider with one.

It is a *drain* order: it spends on the provider whose clock is about to turn,
and among equals prefers the one that has already consumed more.

**Where it is right.** Burst work, free tiers, and any short window you would
otherwise leave unused. It also costs nothing: the clocks are read from the
cached `opencode-usage` snapshot, so ordering never polls a provider.

**Where it is weak**, and worth knowing before you rely on it:

- With nested windows the soonest clock is nearly always the short one, so in
  practice it ranks by *5h reset time* and ignores the weekly and monthly
  windows that will actually stop you. [Pace](#the-rule-that-uses-every-window-pace)
  is the strategy that looks at all of them.
- Its second rule prefers the provider that has used **more** quota. For a
  binding long window that is the wrong direction: it spends the tight account
  before the roomy one.
- It only sees models the eligibility gate left standing. A window at or above
  `QUOTA_BLOCK_PERCENT` (100), or an earlier provider-reported limit, skips its
  models before ordering happens. The last 10% stays usable; ordering cannot
  override a provider's limit.

## The rule that uses every window: pace

`pick.by: "pace"` gives each provider the rate it can sustain until its *own*
binding window resets:

```
pace(P) = min over fresh windows w of  (100 - usedPercent(w)) / minutesUntil(w.reset)
```

Rank providers by `pace` descending. This is water-filling: the provider that
can absorb the most work per minute without hitting any cap goes first, and a
provider with a tight weekly window drops in rank even when its 5h window just
refilled.

**That number answers the per-block question directly.** How much of the weekly
window is left for each 5-hour block still to come is the rate times the block's
length: a weekly at 99% used with two days to go allows `1% / (2 days / 5 hours)`
≈ 0.1% per 5-hour block, however roomy the 5-hour window looks right now. You
never convert by hand — the picker compares rates; the block figure is only for
reading.

A worked example, all percentages illustrative:

| provider | rolling | weekly | monthly | pace (%/min) |
| --- | --- | --- | --- | --- |
| `A` | 96% left, 40m | 99% left, 6d | 95% left, 20d | 0.0033 |
| `B` | 97% left, 6m | 99% left, 2d | — | 0.0344 |
| `C` | 40% left, 90m | 60% left, 3d | — | 0.0139 |

`B` first: its weekly window is the roomiest per minute. `C` is not in trouble
despite the 40% rolling figure, because that window refills in 90 minutes.
`A` is the tightest and goes last even though its rolling window resets in 40
minutes.

Two behaviours to know:

- A window that has already passed its reset constrains nothing and is skipped.
- A provider with no fresh window, or with windows that carry no usage figure,
  has no pace and sorts after every provider that has one.

## In order

`pick.by: "in-order"`, or no `pick` at all, leaves the chain exactly as written.
Nothing is re-ranked by quota, so the first model stays the first try.

**Where it is right.** Models that share one provider bucket — a free tier, a
family with one per-account cap — where reordering by reset or pace would
reshuffle siblings that will be limited together anyway. Also wherever the order
encodes quality rather than availability: flagship first, cheap backstop after.

**Where it is weak.** It ignores quota completely, so it keeps aiming at a
provider whose window is nearly spent until the eligibility gate or a real 429
takes that model out.

## Weighted pace: distribute new assignments

`pick.by: "weighted-pace"` uses the same tightest-window budget as pace, but
turns positive provider weights into a proportional draw rather than always
choosing the largest one. With weights 1 and 3, independent session assignments
approach 25% and 75%. These are assignment shares, not token or dollar shares.
Several models or variants on one provider count as one weight and retain their
declared order within that provider.

The implementation uses weighted rendezvous ordering: each provider gets a
reproducible hash-derived draw `u`, and the smallest `-ln(u) / pace` wins.
The seed includes session, agent, plan and clock hour. Repeating diagnostics
with the same context and evidence does not consume a turn or change a scheduler
counter. Without a session ID, calls share the agent/plan/hour draw; they are not
independent draws per RPC. Missing, zero or invalid weights follow positive
weights, using `pick.path` and then file order as fallbacks.

Both this strategy and window protection require authenticated, error-free quota
observations no older than five minutes, with finite percentages from 0 to 100
and future resets. Eligibility, pins and exclusive reservations still apply.

## Window protection: discount early exhaustion

`pick.by: "window-protection"` ranks by ordinary sustainable pace multiplied by
the smallest usable window factor:

```text
factor = clamp((minutes to 100% at observed rate) / minutes to reset, 0, 1)
protected pace = tightest-window pace × minimum factor
```

For example, a provider with pace 0.25 whose weekly window is forecast to exhaust
in 60 minutes but reset in 180 gets factor 1/3 and score about 0.083. A safe
provider scoring 0.15 then ranks ahead. Weekly and monthly windows participate,
not just the short window. This is a soft ranking penalty, never an extra quota
block or a promise that a window will last until reset.

The observed rate reuses the existing quota history: at least two fresh readings
spanning 15 minutes. A missing or flat trend, stale source, past reset or guessed
reset contributes no penalty (factor 1). Without usable history, this strategy
falls back to fresh pace ranking. No additional provider requests are made.
The ordinary 100%/provider-reported eligibility gate is unchanged.

Both strategies respect the existing one-hour idle preference within a category.
They primarily affect new or reassigned categories, not every turn of an active
sticky session. Earlier eligible plan slots still win.

## Laying out categories and plans

Categories describe **what a model is for**, not who sells it. A good set:

| category | holds | pick |
| --- | --- | --- |
| `cheap` | the small/free models you are happy to run anything on | `pace` |
| `standard` | your everyday mid-tier models | `pace` |
| `deep` | the expensive reasoning models, few requests | `in-order` |
| `long-context` | models with a large window, used rarely | `in-order` |
| `free` | OpenCode Zen free tier, shared bucket | `reset-soonest` |

Use `pace` for a greedy sustainable-budget ranking when the models are
interchangeable. Use `weighted-pace` to spread independent new assignments, or
`window-protection` to discount providers whose observed trend exhausts early. Use
`reset-soonest` when you deliberately want to drain a bucket that is about to
expire — burst jobs, a free tier — and `in-order` where the order encodes
quality, or where the members share a provider bucket.

Then compose plans from the categories, cheapest first and escalating on
capability, with `free` as the last resort so a capped paid provider never
strands a turn:

```jsonc
"categories": {
  "cheap": {
    "models": ["opencode/deepseek-v4.1-flash-free", "opencode-go/deepseek-v4.1-flash"],
    "pick": { "by": "pace", "path": ["opencode-go", "opencode"] }
  },
  "standard": {
    "models": ["opencode-go/glm-5.3", "openai/gpt-6.1-sol"],
    "pick": { "by": "pace", "path": ["openai", "opencode-go"] }
  },
  "deep": ["claude-agent/opus", { "id": "openai/gpt-6.1-sol", "variant": "high" }]
},
"plans": {
  "daily": ["@cheap", "@standard"],
  "review": ["@standard", "@deep", "@cheap"]
}
```

Rules worth keeping:

- **Sticky within a category.** Automatic routing remembers the exact model
  (provider, model and variant) it last assigned or confirmed at admission for a
  session. For up to an hour of idle time, that model moves to the front of its
   own category, so a strategy rank flip does not churn the
  session between interchangeable models. It never moves across plan slots: an
  earlier literal or category still wins, and a recovered earlier category beats
  the sticky fallback. The hour is a routing preference, not a provider cache
  lifetime; plugin restart drops it harmlessly. Actual primary use and a finished
  turn refresh the clock; diagnostics do not.
- **One copy of a model.** A category is expanded inline, so editing it reaches
  every plan that names it. Never list the same model in two categories that
  appear in the same plan; `expandPlan` keeps the first occurrence and silently
  drops the rest.
- **Variants live in the category.** `{ "id": "...", "variant": "high" }` is how
  a thinking level is expressed, so a "thinking level" is a category of one or
  a variant inside a category, not a separate concept.
- **`pick.path` is a preference, not a requirement.** It only breaks ties, and
  it is ignored by `as listed`.
- **Categories in a budget, not yet.** Budgets still measure project, provider,
  model and plugin; there is no category dimension.

## Backstops that change the arithmetic

| setting | effect on this strategy |
| --- | --- |
| `sharedRateLimits` | several models share one bucket. One 429 cools the group, so never treat the members as independent options in a category. |
| `quotaExemptModels` | listed IDs are never skipped for quota. Use for a model you must always be able to reach, not to paper over a capped account. |
| `exclusiveModels` | one seat at a time. A busy model is skipped and the next candidate wins, so put it inside a category rather than in a plan of its own. |
| `providerCooldownMs` | the floor for a cooldown after a rate limit. A provider-stated reset can extend it, never shorten it. A `*-free` model is different: Zen's free allowance is a daily budget, so its rate limit is held until the next 00:00 UTC instead. A probe or a real successful turn still clears it earlier. |
| `probeRateLimits` | only for accounts where one request is cheap, such as a free tier. A probe spends a slot of the very bucket it is asking about. |
| `budgets` | advisory visibility today. They do not gate selection, so they cannot enforce a pace. |

## Reading the numbers

- Windows are cached for five minutes. Older than that, a source is `stale` and
  its availability becomes `unknown`: it does not block a model, but it has no
  pace and no clock, so it sorts last under either strategy.
- `claude-agent` windows come from rate-limit metadata the plugin observed on
  real calls, so they are stale until a Claude call happens in this session.
- An estimated reset (`resetEstimated`) does not restore eligibility on its own.
- Check the live picture with `/qm-status`, the Usage › Providers tab, or the
  dashboard's quota block before assuming a provider is available.

## Next steps that would make this sharper

1. Per-window targets: let a category say which window it cares about
   (`pick.ignore: ["monthly"]`) so a cheap tier can spend short windows hard
   while a premium tier protects the long one.
2. A category dimension for budgets, so spend can be capped by intent.
