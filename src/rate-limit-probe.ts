import type { ModelRef } from "./config.ts"
import { modelKey } from "./select.ts"

/**
 * Opt-in recovery probes for models that are still rate limited.
 *
 * A probe is a separate one-shot generation through the host. It never replays, resends or
 * re-issues a user turn, and it is only ever sent to a model the operator listed in
 * `probeRateLimits`.
 */
export type ProbeOutcome = "success" | "still-limited" | "error"

export interface ProbeRecord {
  providerID: string
  modelID: string
  outcome: ProbeOutcome
  at: number
}

export interface ProbeAttempt {
  /** When the last probe of that bucket was sent. */
  at: number
  /** Consecutive probes that found the bucket still limited. */
  failures: number
}

export interface ProbeDecisionInput {
  now: number
  /** Models the operator opted into probing. */
  models: readonly ModelRef[]
  /** Shared rate-limit groups: their members share one bucket. */
  groups: readonly ModelRef[][]
  /** Known cooldown deadlines per model key, expired entries included. */
  cooldowns: ReadonlyMap<string, number>
  /** Provider-stated reset times per model key. */
  deadlines?: ReadonlyMap<string, number>
  /** Last probe per bucket. */
  lastProbe?: ReadonlyMap<string, ProbeAttempt>
  /** Base probe interval in milliseconds. */
  intervalMs: number
  /** Longest backoff between two probes of one bucket, in milliseconds. */
  maxBackoffMs: number
  /** A primary request is running: never add provider load next to real work. */
  busy?: boolean
}

/** The models that share one rate-limit bucket with the given model. */
export function bucketMembers(model: ModelRef, groups: readonly ModelRef[][]): ModelRef[] {
  const group = groups.find((members) => members.some((member) =>
    member.providerID === model.providerID && member.modelID === model.modelID))
  return group ?? [model]
}

/** A stable identity for the bucket a model belongs to. */
export function bucketId(model: ModelRef, groups: readonly ModelRef[][]): string {
  const members = bucketMembers(model, groups)
  if (members.length === 1) return `model:${modelKey(members[0])}`
  return `group:${members.map((member) => modelKey(member)).sort().join(",")}`
}

/** The wait after the last probe of a bucket: the base interval, doubling per failed probe. */
export function probeBackoffMs(intervalMs: number, failures: number, maxBackoffMs: number): number {
  const scaled = intervalMs * 2 ** Math.max(0, failures)
  return Math.min(scaled, maxBackoffMs)
}

/**
 * Decide which models to probe now: at most one per shared bucket, and only when the bucket's
 * own cooldown floor has expired, no provider-stated reset is pending, the backoff window has
 * elapsed and no primary request is running.
 */
export function selectProbeTargets(input: ProbeDecisionInput): ModelRef[] {
  if (input.busy) return []
  const targets: ModelRef[] = []
  const seen = new Set<string>()
  for (const model of input.models) {
    const bucket = bucketId(model, input.groups)
    if (seen.has(bucket)) continue
    seen.add(bucket)
    const members = bucketMembers(model, input.groups)
    const attempt = input.lastProbe?.get(bucket)
    // A cooldown record, or an earlier probe that found the bucket limited, marks it as limited.
    const cooling = members.filter((member) => input.cooldowns.has(modelKey(member)))
    if (cooling.length === 0 && !attempt) continue
    // The first probe waits for the configured cooldown floor: while the bucket is still known
    // limited by our own window, a probe would spend a request slot for an answer we already have.
    const until = cooling.length === 0
      ? Number.NEGATIVE_INFINITY
      : Math.max(...cooling.map((member) => input.cooldowns.get(modelKey(member))!))
    if (!attempt && input.now < until) continue
    // A provider-stated reset already says when the limit clears.
    const deadline = Math.max(...members.map((member) => input.deadlines?.get(modelKey(member)) ?? Number.NEGATIVE_INFINITY))
    if (deadline > input.now) continue
    // After the first probe the backoff alone drives the schedule: the cooldown floor must not
    // swallow it, or polling would stop at the provider cooldown.
    if (attempt && input.now < attempt.at + probeBackoffMs(input.intervalMs, attempt.failures, input.maxBackoffMs)) continue
    targets.push(model)
  }
  return targets
}

/** Probe state: the last attempt per bucket and the sanitized outcome history. */
export class RateLimitProbes {
  private readonly attempts = new Map<string, ProbeAttempt>()
  private readonly records: ProbeRecord[] = []

  select(input: Omit<ProbeDecisionInput, "lastProbe">): ModelRef[] {
    return selectProbeTargets({ ...input, lastProbe: this.attempts })
  }

  record(model: ModelRef, outcome: ProbeOutcome, now: number, groups: readonly ModelRef[][]): void {
    const bucket = bucketId(model, groups)
    const attempt = this.attempts.get(bucket)
    if (outcome === "success") {
      // The bucket recovered: the next rate limit starts from the base interval again.
      this.attempts.delete(bucket)
    } else {
      this.attempts.set(bucket, {
        at: now,
        failures: outcome === "still-limited" ? (attempt?.failures ?? 0) + 1 : attempt?.failures ?? 0,
      })
    }
    this.records.push({ providerID: model.providerID, modelID: model.modelID, outcome, at: now })
    while (this.records.length > 64) this.records.shift()
  }

  snapshot(): ProbeRecord[] {
    return [...this.records]
  }

  clear(): void {
    this.attempts.clear()
    this.records.length = 0
  }
}
