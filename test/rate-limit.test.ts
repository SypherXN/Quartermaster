import assert from "node:assert/strict"
import test from "node:test"
import { parseRateLimitHeaders, RateLimitObservations } from "../src/rate-limit.ts"

const headers = (values: Record<string, string>) => ({
  get: (name: string) => values[name.toLowerCase()] ?? null,
})

const model = { providerID: "opencode", modelID: "deepseek-v4.1-flash-free" }
const now = 1_700_000_000_000

test("reads a provider's stated reset time from the headers of a response already received", () => {
  const signal = parseRateLimitHeaders(headers({
    "retry-after": "7",
    "x-ratelimit-remaining-requests": "0",
    "x-ratelimit-limit-requests": "20",
  }), now)

  assert.equal(signal?.resetAt, now + 7_000)
  assert.equal(signal?.remaining, 0)
  assert.equal(signal?.limit, 20)
  assert.equal(signal?.source, "retry-after")
})

test("reads an epoch reset and a duration reset in the shapes providers send them", () => {
  const epoch = parseRateLimitHeaders(headers({ "x-ratelimit-reset": "1700003600" }), now)
  assert.equal(epoch?.resetAt, 1_700_003_600_000)

  const duration = parseRateLimitHeaders(headers({ "x-ratelimit-reset-requests": "6m0s" }), now)
  assert.equal(duration?.resetAt, now + 360_000)

  const delta = parseRateLimitHeaders(headers({ "x-ratelimit-reset-tokens": "45" }), now)
  assert.equal(delta?.resetAt, now + 45_000)
})

test("a response without rate-limit headers reports nothing", () => {
  assert.equal(parseRateLimitHeaders(headers({ "content-type": "application/json" }), now), undefined)
})

test("a stated reset is clamped into a usable cooldown window", () => {
  const past = parseRateLimitHeaders(headers({ "retry-after": "0" }), now)
  assert.equal(past?.resetAt, now + 1_000)

  const far = parseRateLimitHeaders(headers({ "retry-after": "172800" }), now)
  assert.equal(far?.resetAt, now + 24 * 60 * 60_000)
})

test("only a rate-limit response states when the limit frees", () => {
  const observations = new RateLimitObservations()
  observations.record(model, { resetAt: now + 60_000 }, now, 429)
  assert.equal(observations.deadline(model, now), now + 60_000)

  // A later success must not erase the reset the provider already stated.
  observations.record(model, {}, now + 1_000, 200)
  assert.equal(observations.deadline(model, now + 1_000), now + 60_000)
  assert.equal(observations.get(model, now + 1_000)?.status, 200)
})

test("a stale observation is no longer trusted", () => {
  const observations = new RateLimitObservations()
  observations.record(model, { resetAt: now + 60_000 }, now, 429)
  assert.equal(observations.deadline(model, now + 15 * 60_000 + 1), undefined)
  assert.deepEqual(observations.snapshot(now + 15 * 60_000 + 1), [])
})

test("a reset that already passed is not a deadline", () => {
  const observations = new RateLimitObservations()
  observations.record(model, { resetAt: now - 1 }, now, 429)
  assert.equal(observations.deadline(model, now), undefined)
})
