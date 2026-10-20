import type { ModelRef } from "./config.ts"

/**
 * Rate-limit state a provider reported on a response the host already received.
 * Nothing here is inferred from usage: it is read from the provider's own headers.
 */
export interface RateLimitSignal {
  /** Provider-stated moment the limit resets, epoch milliseconds. */
  resetAt?: number
  /** Provider-stated remaining requests or tokens, when advertised. */
  remaining?: number
  /** Provider-stated limit, when advertised. */
  limit?: number
  /** Header the reset time came from. */
  source?: string
}

export interface RateLimitObservation extends RateLimitSignal {
  providerID: string
  modelID: string
  observedAt: number
  /** HTTP status of the response the headers came from. */
  status?: number
}

const MAX_SIGNAL_AGE_MS = 15 * 60_000
const MIN_COOLDOWN_MS = 1_000
// A quota window can be hours out; clipping it would make Quartermaster retry a bucket the
// provider already said is closed.
const MAX_COOLDOWN_MS = 24 * 60 * 60_000
// Only a response that was itself a rejection states when the limit frees.
const LIMIT_STATUSES = new Set([402, 429])

const RESET_HEADERS = [
  "retry-after",
  "x-ratelimit-reset",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "ratelimit-reset",
]
const REMAINING_HEADERS = [
  "x-ratelimit-remaining",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "ratelimit-remaining",
]
const LIMIT_HEADERS = [
  "x-ratelimit-limit",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "ratelimit-limit",
]

type HeaderReader = { get(name: string): string | null }

// "6m0s", "1s", "90" -> milliseconds
function durationMs(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1_000
  const parts = trimmed.match(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)
  if (!parts?.length) return undefined
  let total = 0
  for (const part of parts) {
    const amount = Number(part.slice(0, -1).replace(/ms$|h$|m$|s$/, ""))
    if (!Number.isFinite(amount)) return undefined
    if (part.endsWith("ms")) total += amount
    else if (part.endsWith("h")) total += amount * 3_600_000
    else if (part.endsWith("m")) total += amount * 60_000
    else total += amount * 1_000
  }
  return total
}

function numeric(value: string | null): number | undefined {
  if (value === null) return undefined
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Read provider rate-limit headers from one response.
 * `now` anchors relative and epoch forms; the result is clamped to a sane cooldown window.
 */
export function parseRateLimitHeaders(headers: HeaderReader, now: number): RateLimitSignal | undefined {
  let resetAt: number | undefined
  let source: string | undefined
  for (const name of RESET_HEADERS) {
    const raw = headers.get(name)
    if (raw === null) continue
    const trimmed = raw.trim()
    let candidate: number | undefined
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const amount = Number(trimmed)
      // "retry-after" is a delay, the x-ratelimit-reset family is an epoch second.
      candidate = name === "retry-after"
        ? now + amount * 1_000
        : amount > 1_000_000_000 ? amount * 1_000 : now + amount * 1_000
    } else {
      const delta = durationMs(trimmed)
      if (delta !== undefined) candidate = now + delta
      else {
        const epoch = Date.parse(trimmed)
        if (Number.isFinite(epoch)) candidate = epoch
      }
    }
    if (candidate === undefined || !Number.isFinite(candidate)) continue
    if (resetAt === undefined || candidate < resetAt) {
      resetAt = candidate
      source = name
    }
  }

  let remaining: number | undefined
  for (const name of REMAINING_HEADERS) {
    const value = numeric(headers.get(name))
    if (value === undefined) continue
    if (remaining === undefined || value < remaining) remaining = value
  }
  let limit: number | undefined
  for (const name of LIMIT_HEADERS) {
    const value = numeric(headers.get(name))
    if (value === undefined) continue
    if (limit === undefined || value > limit) limit = value
  }

  if (resetAt === undefined && remaining === undefined && limit === undefined) return undefined
  const clamped = resetAt === undefined ? undefined : Math.min(Math.max(resetAt, now + MIN_COOLDOWN_MS), now + MAX_COOLDOWN_MS)
  return {
    ...(clamped === undefined ? {} : { resetAt: clamped }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(limit === undefined ? {} : { limit }),
    ...(source === undefined ? {} : { source }),
  }
}

/**
 * Latest provider rate-limit observation per model, so later automatic assignments can
 * wait for the provider's own reset time instead of a flat guess.
 */
export class RateLimitObservations {
  private readonly observed = new Map<string, RateLimitObservation>()
  private readonly limited = new Map<string, RateLimitObservation>()

  record(
    model: Pick<ModelRef, "providerID" | "modelID">,
    signal: RateLimitSignal,
    now: number,
    status?: number,
  ): void {
    const id = JSON.stringify([model.providerID, model.modelID])
    const observation: RateLimitObservation = {
      ...signal,
      providerID: model.providerID,
      modelID: model.modelID,
      observedAt: now,
      ...(status === undefined ? {} : { status }),
    }
    this.observed.delete(id)
    this.observed.set(id, observation)
    // Only a rejection states when the limit frees; a later success must not erase it.
    if (status !== undefined && LIMIT_STATUSES.has(status)) {
      this.limited.delete(id)
      this.limited.set(id, observation)
    }
    while (this.observed.size > 256) this.observed.delete(this.observed.keys().next().value!)
    while (this.limited.size > 256) this.limited.delete(this.limited.keys().next().value!)
  }

  /** Latest observation for a model, or undefined when none is fresh enough to trust. */
  get(model: Pick<ModelRef, "providerID" | "modelID">, now: number): RateLimitObservation | undefined {
    const found = this.observed.get(JSON.stringify([model.providerID, model.modelID]))
    if (!found || now - found.observedAt > MAX_SIGNAL_AGE_MS) return undefined
    return found
  }

  /** Reset time the provider stated on a rate-limit response, when it is still in the future. */
  deadline(model: Pick<ModelRef, "providerID" | "modelID">, now: number): number | undefined {
    const found = this.limited.get(JSON.stringify([model.providerID, model.modelID]))
    if (!found || now - found.observedAt > MAX_SIGNAL_AGE_MS) return undefined
    if (!found.resetAt || found.resetAt <= now) return undefined
    return found.resetAt
  }

  snapshot(now: number): RateLimitObservation[] {
    return [...this.observed.values()].filter((entry) => now - entry.observedAt <= MAX_SIGNAL_AGE_MS)
  }

  clear(): void {
    this.observed.clear()
    this.limited.clear()
  }
}
