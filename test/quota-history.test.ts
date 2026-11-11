import assert from "node:assert/strict"
import test from "node:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { registerAgentRouting } from "../src/agent-routing.ts"
import { parseConfig } from "../src/config.ts"
import { QuotaEstimates } from "../src/quota-estimates.ts"
import {
  QUOTA_HISTORY_RETENTION_MS,
  QuotaHistory,
  quotaHistoryQueryFromInput,
  type QuotaHistoryResult,
} from "../src/quota-history.ts"
import { QUARTERMASTER_RPC, registerQuartermasterRpc } from "../src/rpc.ts"
import { QuotaValueTracker } from "../src/quota-values.ts"
import type { UsageReadResult, UsageSnapshot, UsageSource, UsageSourceID, UsageWindow } from "../src/usage.ts"

const MIN = 60_000
const DAY = 86_400_000
const t0 = Date.now()

function usageAt(
  at: number,
  percent: number,
  options: {
    sourceID?: UsageSourceID
    resetsAt?: number | null
    resetEstimated?: boolean
    stale?: boolean
    authenticated?: boolean
    error?: string | null
    windows?: UsageWindow[]
  } = {},
): UsageReadResult {
  const sourceID = options.sourceID ?? "go"
  const windows = options.windows ?? [{
    name: "weekly",
    usedPercent: percent,
    state: "ok",
    resetsAt: options.resetsAt ?? null,
    ...(options.resetEstimated === undefined ? {} : { resetEstimated: options.resetEstimated }),
  }]
  const source: UsageSource = {
    authenticated: options.authenticated ?? true,
    checkedAt: at,
    stale: options.stale ?? false,
    error: options.error ?? null,
    windows,
    nextAvailableAt: null,
    availability: "available",
  }
  const empty: UsageSource = {
    authenticated: true, checkedAt: at, stale: false, error: null, windows: [], nextAvailableAt: null, availability: "available",
  }
  const sources: UsageSnapshot["sources"] = { go: empty, codex: empty, cursor: empty }
  sources[sourceID] = source
  return { status: "ok", snapshot: { updatedAt: at, sources } }
}

function fakeStorage(options: {
  scan?: boolean
  remove?: boolean
  pageSize?: number
  failGet?: (key: string) => boolean
  failSet?: (key: string, value: unknown) => boolean
} = {}) {
  const map = new Map<string, unknown>()
  const faults = { set: 0, remove: 0 }
  // Clone on get/set like a real JSON store, so callers cannot mutate a stored
  // row by holding the object they passed in.
  const storage: Record<string, unknown> = {
    get: async (key: string) => {
      if (options.failGet?.(key)) throw new Error("get failed")
      return structuredClone(map.get(key))
    },
    set: async (key: string, value: unknown) => {
      if (faults.set > 0) { faults.set -= 1; throw new Error("set failed") }
      if (options.failSet?.(key, value)) throw new Error("set failed")
      map.set(key, structuredClone(value))
    },
    remove: async (key: string) => {
      if (faults.remove > 0) { faults.remove -= 1; throw new Error("remove failed") }
      map.delete(key)
    },
    scan: async ({ prefix, after, limit }: { prefix: string; after?: string; limit?: number }) => {
      const keys = [...map.keys()]
        .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort()
      const size = Math.max(1, Math.min(limit ?? 1_000, options.pageSize ?? 1_000))
      const page = keys.slice(0, size)
      return {
        entries: page.map((key) => ({ key, value: map.get(key) })),
        ...(keys.length > page.length ? { next: page[page.length - 1] } : {}),
      }
    },
  }
  if (options.scan === false) delete storage.scan
  if (options.remove === false) delete storage.remove
  return { map, faults, storage: storage as never }
}

const seriesKeyFor = (sourceID: string, windowName: string) =>
  `routing/quota-history-v1/series/${encodeURIComponent(JSON.stringify([sourceID, windowName]))}`
const pointKeyFor = (sourceID: string, windowName: string, at: number) =>
  `routing/quota-history-v1/points/${encodeURIComponent(JSON.stringify([sourceID, windowName]))}/${String(at).padStart(16, "0")}`
const cumulativeKeyFor = (sourceID: string, windowName: string) =>
  `routing/quota-history-v1/cumulative/${encodeURIComponent(JSON.stringify([sourceID, windowName]))}`

function storedPoint(sourceID: string, windowName: string, at: number, percent = 50, estimate?: unknown) {
  return {
    version: 1,
    sourceID,
    windowName,
    observedAt: at,
    percent,
    state: "ok",
    resetsAt: null,
    resetEstimated: false,
    cycleBoundary: false,
    estimate: estimate ?? { status: "insufficient-history", cutoffPercent: 100, sampleCount: 1, spanMs: 0 },
  }
}

function seedSeries(map: Map<string, unknown>, sourceID: string, windowName: string, timestamps: number[]) {
  const last = timestamps[timestamps.length - 1]
  map.set(seriesKeyFor(sourceID, windowName), {
    version: 1, sourceID, windowName,
    lastObservedAt: last, lastPercent: 50, lastResetsAt: null, lastResetEstimated: false,
  })
  for (const at of timestamps) map.set(pointKeyFor(sourceID, windowName, at), storedPoint(sourceID, windowName, at))
}

const pointKeys = (map: Map<string, unknown>) =>
  [...map.keys()].filter((key) => key.startsWith("routing/quota-history-v1/points/"))

async function record(
  history: QuotaHistory,
  estimates: QuotaEstimates,
  usage: UsageReadResult,
  now = usage.snapshot.updatedAt,
): Promise<boolean> {
  estimates.observe(usage, now)
  return await history.record(usage, estimates, now)
}

test("archives the actual estimate snapshot and dedupes cached timestamps across restart", async () => {
  const { storage, map } = fakeStorage()
  const clock = { now: t0 }
  const history = new QuotaHistory(storage, () => clock.now)
  const estimates = new QuotaEstimates()
  const resetAt = t0 + 60 * MIN
  const first = usageAt(t0, 40, { resetsAt: resetAt })
  const second = usageAt(t0 + 15 * MIN, 50, { resetsAt: resetAt })

  assert.equal(await record(history, estimates, first, t0), true)
  assert.equal(await record(history, estimates, second, t0 + 15 * MIN), true)
  // The same cached checkedAt is one observation, not a second sample.
  assert.equal(await record(history, estimates, second, t0 + 15 * MIN), false)

  clock.now = t0 + 15 * MIN
  const page = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(page.status, "ok")
  assert.equal(page.points.length, 2)
  const [warmup, estimated] = page.points
  assert.equal(warmup.estimate.status, "insufficient-history")
  assert.equal(warmup.estimate.sampleCount, 1)
  assert.equal(warmup.percent, 40)
  assert.equal(warmup.state, "ok")
  assert.equal(warmup.resetsAt, resetAt)
  assert.equal(warmup.resetEstimated, false)
  assert.equal(estimated.estimate.status, "estimated")
  assert.equal(estimated.estimate.cutoffPercent, 100)
  assert.equal(estimated.estimate.sampleCount, 2)
  assert.equal(estimated.estimate.spanMs, 15 * MIN)
  assert.ok(Math.abs((estimated.estimate.ratePerMinute ?? 0) - 10 / 15) < 1e-9)
  assert.equal(estimated.estimate.cutoffAt, t0 + 15 * MIN + 75 * MIN)

  // A restart reloads the persisted head, so the cached clock still dedupes.
  const restarted = new QuotaHistory(storage, () => clock.now)
  const restartedEstimates = new QuotaEstimates()
  restartedEstimates.observe(first, t0)
  restartedEstimates.observe(second, t0 + 15 * MIN)
  assert.equal(await restarted.record(second, restartedEstimates, t0 + 15 * MIN), false)
  const afterRestart = await restarted.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(afterRestart.points.length, 2)
  assert.equal(pointKeys(map).length, 2)
})

test("marks a new cycle only on a drop or a crossed deadline, not on a moving deadline or flag change", async () => {
  const { storage } = fakeStorage()
  const history = new QuotaHistory(storage, () => t0 + 73 * MIN)
  const estimates = new QuotaEstimates()
  const reset = t0 + 60 * MIN

  const steps: Array<{ at: number; percent: number; resetsAt: number | null; resetEstimated?: boolean }> = [
    { at: t0, percent: 40, resetsAt: reset },
    // Rolling deadline moves forward: same cycle.
    { at: t0 + 5 * MIN, percent: 45, resetsAt: reset + 10 * MIN },
    // A flag change alone is same cycle too.
    { at: t0 + 10 * MIN, percent: 45, resetsAt: reset + 10 * MIN, resetEstimated: true },
    // A percentage drop is a new cycle.
    { at: t0 + 15 * MIN, percent: 30, resetsAt: reset + 10 * MIN },
    // The one observation that crosses the previous deadline is a new cycle.
    { at: t0 + 71 * MIN, percent: 36, resetsAt: reset + 10 * MIN },
    // Later reads still carrying that now-past deadline are not new cycles.
    { at: t0 + 72 * MIN, percent: 37, resetsAt: reset + 10 * MIN },
    { at: t0 + 73 * MIN, percent: 38, resetsAt: reset + 10 * MIN },
  ]
  const expected = [false, false, false, true, true, false, false]
  for (const step of steps) {
    await record(history, estimates, usageAt(step.at, step.percent, {
      resetsAt: step.resetsAt,
      ...(step.resetEstimated === undefined ? {} : { resetEstimated: step.resetEstimated }),
    }), step.at)
  }
  const page = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.deepEqual(page.points.map((point) => point.cycleBoundary), expected)

  // Unknown resets stay unknown and cannot create a deadline boundary.
  const unknown = new QuotaHistory(storage, () => t0 + 5 * MIN)
  await record(unknown, estimates, usageAt(t0, 50, { sourceID: "codex", resetsAt: null }), t0)
  await record(unknown, estimates, usageAt(t0 + 5 * MIN, 55, { sourceID: "codex", resetsAt: null }), t0 + 5 * MIN)
  const unknownPage = await unknown.query({ sourceID: "codex", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(unknownPage.points.length, 2)
  assert.deepEqual(unknownPage.points.map((point) => point.resetsAt), [null, null])
  assert.deepEqual(unknownPage.points.map((point) => point.cycleBoundary), [false, false])
})

test("keeps every raw point inside 90 days and folds older ones cumulatively at the exact boundary", async () => {
  const { storage, map } = fakeStorage()
  let clock = t0
  const history = new QuotaHistory(storage, () => clock)
  const estimates = new QuotaEstimates()
  const end = t0 + 100 * DAY
  const cutoff = end - QUOTA_HISTORY_RETENTION_MS
  const points = [
    { at: t0, percent: 10 },
    { at: t0 + MIN, percent: 20 },
    { at: cutoff - 1, percent: 5 },
    { at: cutoff, percent: 40 },
    { at: end - 60 * MIN, percent: 50 },
  ]
  for (const point of points) await record(history, estimates, usageAt(point.at, point.percent), point.at)

  clock = end
  const page = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(page.status, "ok")
  // The exact-cutoff observation and the recent one stay raw; everything older folded.
  assert.deepEqual(page.points.map((point) => point.observedAt), [cutoff, end - 60 * MIN])
  assert.ok(page.points.every((point) => point.observedAt >= cutoff))
  assert.equal(pointKeys(map).length, 2)
  const cumulative = page.cumulative
  assert.ok(cumulative)
  assert.equal(cumulative.observations, 3)
  assert.equal(cumulative.cycleBoundaries, 1)
  assert.equal(cumulative.committedThrough, cutoff - 1)
  assert.equal(cumulative.firstObservedAt, t0)
  assert.equal(cumulative.lastObservedAt, cutoff - 1)
  assert.equal(cumulative.percentMin, 5)
  assert.equal(cumulative.percentMax, 20)
  assert.equal(cumulative.percentLast, 5)
  assert.equal(cumulative.statusCounts["insufficient-history"], 3)

  // Re-running compaction is idempotent and folds nothing twice.
  await history.compact(end)
  await history.compact(end)
  const again = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(again.cumulative?.observations, 3)
  assert.equal(again.cumulative?.cycleBoundaries, 1)
  assert.equal(pointKeys(map).length, 2)
})

test("a failed fold write or delete retries without losing or double-counting observations", async () => {
  const setup = async () => {
    const fixture = fakeStorage()
    const history = new QuotaHistory(fixture.storage, () => t0)
    const estimates = new QuotaEstimates()
    await record(history, estimates, usageAt(t0 - 100 * DAY, 10), t0 - 100 * DAY)
    await record(history, estimates, usageAt(t0 - 99 * DAY, 20), t0 - 99 * DAY)
    return { ...fixture, history }
  }

  // The cumulative write fails before anything is removed: retry folds once.
  const writeFail = await setup()
  writeFail.faults.set = 1
  await assert.rejects(writeFail.history.compact(t0))
  assert.equal(pointKeys(writeFail.map).length, 2)
  await writeFail.history.compact(t0)
  assert.equal(pointKeys(writeFail.map).length, 0)
  const written = await writeFail.history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(written.cumulative?.observations, 2)
  assert.equal(written.points.length, 0)
  await writeFail.history.compact(t0)
  const afterRetry = await writeFail.history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(afterRetry.cumulative?.observations, 2)

  // The checkpoint lands, then a delete fails: retry removes the leftovers only.
  const removeFail = await setup()
  removeFail.faults.remove = 1
  await assert.rejects(removeFail.history.compact(t0))
  assert.equal(pointKeys(removeFail.map).length, 2)
  await removeFail.history.compact(t0)
  assert.equal(pointKeys(removeFail.map).length, 0)
  const cleaned = await removeFail.history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(cleaned.cumulative?.observations, 2)

  // A point write failure leaves the head untouched: the retry stores it once.
  const appendFail = fakeStorage()
  const history = new QuotaHistory(appendFail.storage, () => t0)
  const estimates = new QuotaEstimates()
  appendFail.faults.set = 1
  await assert.rejects(record(history, estimates, usageAt(t0, 30), t0))
  assert.equal(await record(history, estimates, usageAt(t0, 30), t0), true)
  const appended = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(appended.points.length, 1)
  assert.equal(pointKeys(appendFail.map).length, 1)
})

test("folds a large backlog incrementally page by page", async () => {
  const { storage, map } = fakeStorage({ pageSize: 1_000 })
  const history = new QuotaHistory(storage, () => t0)
  const timestamps = Array.from({ length: 2_500 }, (_, index) => t0 - 100 * DAY + index * 1_000)
  seedSeries(map, "go", "weekly", timestamps)

  await history.compact(t0)
  assert.equal(pointKeys(map).length, 0)
  const page = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(page.cumulative?.observations, 2_500)
  assert.equal(page.cumulative?.committedThrough, timestamps[timestamps.length - 1])
  assert.equal(page.points.length, 0)
})

test("a fold failure on a later page retries from the last checkpoint", async () => {
  let failSecondPage = false
  const { storage, map } = fakeStorage({
    pageSize: 2,
    failSet: (_key, value) => failSecondPage && (value as { observations?: unknown }).observations === 4,
  })
  const history = new QuotaHistory(storage, () => t0)
  const timestamps = Array.from({ length: 5 }, (_, index) => t0 - 100 * DAY + index * 1_000)
  seedSeries(map, "go", "weekly", timestamps)

  failSecondPage = true
  await assert.rejects(history.compact(t0))
  // Page one committed; later raw points survive for the retry.
  assert.equal((map.get(cumulativeKeyFor("go", "weekly")) as { observations: number }).observations, 2)
  assert.equal(pointKeys(map).length, 3)

  failSecondPage = false
  await history.compact(t0)
  assert.equal(pointKeys(map).length, 0)
  const page = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(page.cumulative?.observations, 5)
})

test("a transient cumulative read failure aborts folding and preserves totals", async () => {
  let fail = false
  const { storage, map } = fakeStorage({
    failGet: (key) => fail && key.startsWith("routing/quota-history-v1/cumulative/"),
  })
  const history = new QuotaHistory(storage, () => t0)
  const estimates = new QuotaEstimates()
  await record(history, estimates, usageAt(t0 - 100 * DAY, 10), t0 - 100 * DAY)
  await record(history, estimates, usageAt(t0 - 99 * DAY, 20), t0 - 99 * DAY)
  await history.compact(t0)
  const key = cumulativeKeyFor("go", "weekly")
  const folded = structuredClone(map.get(key))
  assert.equal((folded as { observations: number }).observations, 2)

  // A new expired point arrives after the fold, then the checkpoint read fails.
  await record(history, estimates, usageAt(t0 - 98 * DAY, 30), t0 - 98 * DAY)
  assert.equal(pointKeys(map).length, 1)
  fail = true
  await assert.rejects(history.compact(t0))
  assert.deepEqual(map.get(key), folded)
  assert.equal(pointKeys(map).length, 1)

  fail = false
  await history.compact(t0)
  const page = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(page.cumulative?.observations, 3)
  assert.equal(pointKeys(map).length, 0)
})

test("a malformed checkpoint fails closed and never deletes raw points", async () => {
  const { storage, map } = fakeStorage()
  const history = new QuotaHistory(storage, () => t0)
  const estimates = new QuotaEstimates()
  await record(history, estimates, usageAt(t0 - 100 * DAY, 10), t0 - 100 * DAY)
  await record(history, estimates, usageAt(t0 - 99 * DAY, 20), t0 - 99 * DAY)
  const key = cumulativeKeyFor("go", "weekly")
  const malformed = { version: 1, observations: "lots" }
  map.set(key, malformed)

  await assert.rejects(history.compact(t0))
  assert.equal(pointKeys(map).length, 2)
  assert.deepEqual(map.get(key), malformed)
  // A read also refuses rather than folding against an unreadable checkpoint.
  assert.deepEqual(await history.query({ sourceID: "go", windowName: "weekly" }), {
    status: "unavailable", reason: "storage-unavailable",
  })
  assert.equal(pointKeys(map).length, 2)

  map.delete(key)
  await history.compact(t0)
  const page = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(page.cumulative?.observations, 2)
})

test("a failed head write recovers the original point instead of overwriting its forecast", async () => {
  let failHead = false
  const { storage, map } = fakeStorage({
    failSet: (key) => failHead && key.startsWith("routing/quota-history-v1/series/"),
  })
  const history = new QuotaHistory(storage, () => t0)
  const estimates = new QuotaEstimates()
  const usage = usageAt(t0, 40)
  failHead = true
  await assert.rejects(record(history, estimates, usage, t0))
  assert.equal(pointKeys(map).length, 1)
  assert.equal([...map.keys()].some((key) => key.startsWith("routing/quota-history-v1/series/")), false)
  const original = structuredClone(map.get(pointKeyFor("go", "weekly", t0)))

  // A different estimator would produce a different forecast at this clock.
  const later = new QuotaEstimates()
  later.observe(usageAt(t0 - 60 * MIN, 30), t0 - 60 * MIN)
  later.observe(usage, t0)
  failHead = false
  const restarted = new QuotaHistory(storage, () => t0 + 5 * MIN)
  assert.equal(await restarted.record(usage, later, t0), false)
  assert.deepEqual(map.get(pointKeyFor("go", "weekly", t0)), original)

  // Resumed writes keep the orphan and recover the head from it.
  await record(restarted, later, usageAt(t0 + 5 * MIN, 45), t0 + 5 * MIN)
  const page = await restarted.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(page.points.length, 2)
  assert.deepEqual(page.points[0], original)
})

test("keeps every legitimate window and pages the catalog without eviction", async () => {
  const { storage, map } = fakeStorage()
  const history = new QuotaHistory(storage, () => t0)
  const estimates = new QuotaEstimates()
  const windows = Array.from({ length: 70 }, (_, index) => ({
    name: `window-${String(index).padStart(2, "0")}`,
    usedPercent: 10 + index % 20,
    state: "ok" as const,
    resetsAt: null,
  }))
  await record(history, estimates, usageAt(t0, 10, { windows }), t0)
  assert.equal([...map.keys()].filter((key) => key.startsWith("routing/quota-history-v1/series/")).length, 70)

  const seen = new Set<string>()
  let cursor: string | undefined
  for (let pages = 0; pages < 10; pages++) {
    const page = await history.query({
      limit: 30, ...(cursor === undefined ? {} : { catalogCursor: cursor }),
    }) as QuotaHistoryResult
    assert.equal(page.points.length, 0)
    for (const entry of page.catalog) seen.add(entry.windowName)
    cursor = page.nextCatalogCursor ?? undefined
    if (cursor === undefined) break
  }
  assert.equal(seen.size, 70)
  const last = await history.query({ sourceID: "go", windowName: "window-69" }) as QuotaHistoryResult
  assert.equal(last.points.length, 1)
  assert.equal(last.points[0].percent, 10 + 69 % 20)
})

test("malformed archived forecasts are omitted without deletion or poisoning", async () => {
  const { storage, map } = fakeStorage()
  const history = new QuotaHistory(storage, () => t0)
  const seeded: Array<{ at: number; estimate: unknown }> = [
    { at: t0 - 5 * MIN, estimate: { status: "estimated", cutoffPercent: 100, sampleCount: 2, spanMs: 15 * MIN, ratePerMinute: 0, cutoffAt: t0 + MIN } },
    { at: t0 - 4 * MIN, estimate: { status: "estimated", cutoffPercent: 100, sampleCount: 2, spanMs: 15 * MIN, cutoffAt: t0 + MIN } },
    { at: t0 - 3 * MIN, estimate: { status: "estimated", cutoffPercent: 100, sampleCount: 1, spanMs: 0, ratePerMinute: 1, cutoffAt: t0 + MIN } },
    { at: t0 - 2 * MIN, estimate: { status: "insufficient-history", cutoffPercent: 100, sampleCount: 1, spanMs: 0, ratePerMinute: 1 } },
    { at: t0 - MIN, estimate: { status: "insufficient-history", cutoffPercent: 101, sampleCount: 1, spanMs: 0 } },
  ]
  for (const entry of seeded) map.set(pointKeyFor("go", "weekly", entry.at), storedPoint("go", "weekly", entry.at, 50, entry.estimate))
  map.set(seriesKeyFor("go", "weekly"), {
    version: 1, sourceID: "go", windowName: "weekly",
    lastObservedAt: t0 - MIN, lastPercent: 50, lastResetsAt: null, lastResetEstimated: false,
  })

  const page = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(page.points.length, 0)
  assert.equal(pointKeys(map).length, seeded.length)
  assert.equal(map.has(cumulativeKeyFor("go", "weekly")), false)

  // A valid point's extra fields are dropped from the whitelisted output.
  const valid = storedPoint("go", "weekly", t0 - 10 * MIN)
  map.set(pointKeyFor("go", "weekly", t0 - 10 * MIN), { ...valid, secret: "x", estimate: { ...valid.estimate, secret: "y" } })
  const clean = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(clean.points.length, 1)
  assert.deepEqual(Object.keys(clean.points[0]).sort(), [
    "cycleBoundary", "estimate", "observedAt", "percent", "resetEstimated", "resetsAt", "sourceID", "state", "version", "windowName",
  ].sort())
  assert.deepEqual(Object.keys(clean.points[0].estimate).sort(), ["cutoffPercent", "sampleCount", "spanMs", "status"])
})

test("one row per observation, no blob rewrite, and no sampling cap", async () => {
  const { storage, map } = fakeStorage()
  const history = new QuotaHistory(storage, () => t0)
  const estimates = new QuotaEstimates()
  for (let index = 0; index < 200; index++) {
    const at = t0 + index * MIN
    await record(history, estimates, usageAt(at, 10 + index * 0.1), at)
  }
  assert.equal(pointKeys(map).length, 200)
  assert.equal([...map.keys()].filter((key) => key.startsWith("routing/quota-history-v1/series/")).length, 1)
  assert.equal([...map.keys()].filter((key) => key.startsWith("routing/quota-history-v1/cumulative/")).length, 0)
  // Every stored value is a single observation or one small head row.
  for (const value of map.values()) assert.ok(JSON.stringify(value).length < 2_000)

  const page = await history.query({ sourceID: "go", windowName: "weekly", limit: 1_000 }) as QuotaHistoryResult
  assert.equal(page.points.length, 200)
  assert.equal(page.nextCursor, null)
  assert.equal(page.metadata.rawRetentionMs, QUOTA_HISTORY_RETENTION_MS)
})

test("paginates points by series with canonical cursors and applies ranges without losing order", async () => {
  const { storage } = fakeStorage()
  let clock = t0
  const history = new QuotaHistory(storage, () => clock)
  const estimates = new QuotaEstimates()
  const at = (index: number) => t0 + index * MIN
  for (let index = 0; index < 5; index++) await record(history, estimates, usageAt(at(index), 10 + index), at(index))
  clock = at(4)

  const first = await history.query({ sourceID: "go", windowName: "weekly", limit: 2 }) as QuotaHistoryResult
  assert.deepEqual(first.points.map((point) => point.observedAt), [at(0), at(1)])
  assert.equal(first.nextCursor, String(at(1)))

  const second = await history.query({ sourceID: "go", windowName: "weekly", limit: 2, cursor: first.nextCursor! }) as QuotaHistoryResult
  assert.deepEqual(second.points.map((point) => point.observedAt), [at(2), at(3)])
  assert.equal(second.nextCursor, String(at(3)))

  const third = await history.query({ sourceID: "go", windowName: "weekly", limit: 2, cursor: second.nextCursor! }) as QuotaHistoryResult
  assert.deepEqual(third.points.map((point) => point.observedAt), [at(4)])
  assert.equal(third.nextCursor, null)

  const ranged = await history.query({ sourceID: "go", windowName: "weekly", from: at(1), to: at(3) }) as QuotaHistoryResult
  assert.deepEqual(ranged.points.map((point) => point.observedAt), [at(1), at(2), at(3)])
  const early = await history.query({ sourceID: "go", windowName: "weekly", to: at(1) }) as QuotaHistoryResult
  assert.deepEqual(early.points.map((point) => point.observedAt), [at(0), at(1)])
  const late = await history.query({ sourceID: "go", windowName: "weekly", from: at(3) }) as QuotaHistoryResult
  assert.deepEqual(late.points.map((point) => point.observedAt), [at(3), at(4)])

  // Catalog scope never scans the raw history; another window is simply empty.
  const catalog = await history.query() as QuotaHistoryResult
  assert.equal(catalog.points.length, 0)
  assert.equal(catalog.catalog.length, 1)
  assert.equal(catalog.catalog[0].lastObservedAt, at(4))
  const other = await history.query({ sourceID: "go", windowName: "daily" }) as QuotaHistoryResult
  assert.equal(other.points.length, 0)
  assert.equal(other.catalog.length, 0)
})

test("stale, unauthenticated, errored, future and absent observations never create or delete points", async () => {
  const { storage } = fakeStorage()
  const history = new QuotaHistory(storage, () => t0)
  const estimates = new QuotaEstimates()
  await record(history, estimates, usageAt(t0, 40), t0)

  const rejected = [
    usageAt(t0 + MIN, 50, { stale: true }),
    usageAt(t0 + MIN, 50, { authenticated: false }),
    usageAt(t0 + MIN, 50, { error: "authentication failed" }),
    usageAt(t0 + 2 * MIN, 50),
    usageAt(t0 - 6 * MIN, 50),
    usageAt(t0 + MIN, 50, { windows: [{ name: "weekly", usedPercent: null, state: "unknown", resetsAt: null }] }),
  ]
  for (const usage of rejected) {
    estimates.observe(usage, usage.snapshot.updatedAt)
    assert.equal(await history.record(usage, estimates, t0), false)
  }
  // Future and too-old checkedAt values are judged against the observation clock.
  assert.equal(await record(history, estimates, usageAt(t0 + 2 * MIN, 50), t0), false)

  const page = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(page.points.length, 1)

  // A usage read without a fresh go source must not erase the archived point.
  await record(history, estimates, usageAt(t0 + MIN, 50, { sourceID: "codex" }), t0 + MIN)
  const survived = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(survived.points.length, 1)
})

test("history is the archived forecast, never rewritten by later observations", async () => {
  const { storage } = fakeStorage()
  const history = new QuotaHistory(storage, () => t0 + 30 * MIN)
  const estimates = new QuotaEstimates()
  await record(history, estimates, usageAt(t0, 40), t0)
  await record(history, estimates, usageAt(t0 + 15 * MIN, 50), t0 + 15 * MIN)
  const original = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  const archived = structuredClone(original.points[1])

  await record(history, estimates, usageAt(t0 + 20 * MIN, 55), t0 + 20 * MIN)
  await record(history, estimates, usageAt(t0 + 25 * MIN, 60), t0 + 25 * MIN)
  const later = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.deepEqual(later.points[1], archived)
  assert.ok((later.points[3].estimate.ratePerMinute ?? 0) > (archived.estimate.ratePerMinute ?? 0))
})

test("query input validation rejects malformed bounds, cursors and filters", () => {
  const catalogCursor = encodeURIComponent(JSON.stringify(["go", "weekly"]))
  assert.equal(quotaHistoryQueryFromInput({ catalogCursor }).ok, true)
  const valid = quotaHistoryQueryFromInput({ sourceID: "go", windowName: "weekly", from: 1, to: 2, limit: 10, cursor: "1" })
  assert.equal(valid.ok, true)
  assert.equal(quotaHistoryQueryFromInput({}).ok, true)
  for (const invalid of [
    null, [], { extra: 1 }, { sourceID: "go" }, { windowName: "weekly" },
    { from: 1 }, { to: 1 }, { cursor: "1" },
    { sourceID: " ", windowName: "weekly" }, { sourceID: "go", windowName: "weekly", from: -1 },
    { sourceID: "go", windowName: "weekly", from: 2, to: 1 },
    { sourceID: "go", windowName: "weekly", limit: 0 },
    { sourceID: "go", windowName: "weekly", limit: 1_001 },
    { sourceID: "go", windowName: "weekly", limit: 1.5 },
    { sourceID: "go", windowName: "weekly", cursor: "01" },
    { sourceID: "go", windowName: "weekly", cursor: "-1" },
    { sourceID: "go", windowName: "weekly", cursor: "1.0" },
    { sourceID: "go", windowName: "weekly", cursor: "" },
    { sourceID: "go", windowName: "weekly", cursor: 1 },
    { sourceID: "go", windowName: "weekly", catalogCursor },
    { catalogCursor: "not-a-cursor" },
    { catalogCursor: encodeURIComponent(JSON.stringify(["go"])) },
    { catalogCursor: JSON.stringify(["go", "weekly"]) },
    { catalogCursor: 1 },
  ]) {
    assert.equal(quotaHistoryQueryFromInput(invalid).ok, false, JSON.stringify(invalid))
  }
})

test("the RPC validates quota history input and merges routing results", async () => {
  const calls: unknown[] = []
  const routing = {
    quotaHistory: async (query: unknown) => {
      calls.push(query)
      return {
        status: "ok",
        catalog: [],
        points: [],
        nextCursor: null,
        nextCatalogCursor: null,
        cumulative: null,
        metadata: { rawRetentionMs: QUOTA_HISTORY_RETENTION_MS, rawSince: 0, pageSize: 200,
          pointScope: "one source and window per query",
          cumulativeBasis: "lifetime before raw retention; from/to apply to raw points only",
          rangeAppliesTo: "points" },
      }
    },
  }
  const fixture = rpcFixture(routing)
  await fixture.register()
  const result = await fixture.client().quotaHistory({ sourceID: "go", windowName: "weekly", limit: 5 })
  assert.equal(result.apiVersion, 1)
  assert.equal(result.status, "ok")
  assert.deepEqual(calls, [{ sourceID: "go", windowName: "weekly", limit: 5 }])
  const catalogCursor = encodeURIComponent(JSON.stringify(["go", "weekly"]))
  await fixture.client().quotaHistory({ catalogCursor, limit: 5 })
  assert.deepEqual(calls[1], { catalogCursor, limit: 5 })

  for (const invalid of [
    { sourceID: "go" }, { windowName: "weekly" }, { extra: true }, { from: 5 }, { cursor: "1" },
    { sourceID: "go", windowName: "weekly", from: -1 },
    { sourceID: "go", windowName: "weekly", from: 5, to: 4 },
    { sourceID: "go", windowName: "weekly", limit: 0 },
    { sourceID: "go", windowName: "weekly", cursor: "abc" },
    { sourceID: "go", windowName: "weekly", catalogCursor },
    { catalogCursor: "not-a-cursor" },
  ]) {
    await assert.rejects(fixture.client().quotaHistory(invalid), { code: "invalid_input" })
  }

  const absent = rpcFixture(undefined)
  await absent.register()
  assert.deepEqual(await absent.client().quotaHistory({ sourceID: "go", windowName: "weekly" }), {
    apiVersion: 1, status: "unavailable", reason: "not-configured",
  })
})

test("the router records the archive and a storage without scan/remove degrades gracefully", async () => {
  const usage = usageAt(t0, 50, { sourceID: "codex", resetsAt: t0 + 30 * MIN })
  const config = parseConfig({ usageSources: { openai: "codex" } })
  const tracker = new QuotaValueTracker(config)
  const full = fakeStorage()
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: [{ providerID: "openai", id: "model-a", enabled: true }] }) },
    storage: full.storage,
    rpc: () => ({ status: async () => usage }),
    agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
  } as never, config, usage, undefined, undefined, tracker)
  assert.ok(routing)
  try {
    const status = await routing.status() as { status: string; sources: Record<string, { windows: Array<{ usedPercent: number; apiValue?: { trackingSince: number | null; observedUSD: number | null } }> }> }
    assert.equal(status.status, "ok")
    assert.equal(status.sources.openai.windows[0].usedPercent, 50)
    assert.equal(status.sources.openai.windows[0].apiValue?.trackingSince, t0)
    const page = await routing.quotaHistory({ sourceID: "codex", windowName: "weekly" })
    assert.equal(page.status, "ok")
    if (page.status === "ok") {
      assert.equal(page.points.length, 1)
      assert.equal(page.points[0].observedAt, t0)
      assert.equal(page.points[0].percent, 50)
      assert.ok(page.points[0].estimate)
      assert.equal(page.points[0].apiValue?.trackingSince, t0)
      assert.equal(page.points[0].apiValue?.observedUSD, null)
    }
  } finally {
    await routing.dispose()
  }
  // The same router with a storage domain that cannot scan/remove must still route.
  const narrow = fakeStorage({ scan: false, remove: false })
  const narrowed = await registerAgentRouting({
    model: { list: async () => ({ data: [{ providerID: "openai", id: "model-a", enabled: true }] }) },
    storage: narrow.storage,
    rpc: () => ({ status: async () => usage }),
    agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
  } as never, config, usage)
  assert.ok(narrowed)
  try {
    const status = await narrowed.status() as { status: string }
    assert.equal(status.status, "ok")
    assert.deepEqual(await narrowed.quotaHistory({ sourceID: "codex", windowName: "weekly" }), {
      status: "unavailable", reason: "storage-unavailable",
    })
  } finally {
    await narrowed.dispose()
  }
})

function rpcFixture(routing: unknown) {
  let handlers: Record<string, (input: unknown, call: never) => unknown> | undefined
  const rpc = Object.assign(
    (definition: { id: string }) => {
      if (!handlers || definition.id !== QUARTERMASTER_RPC.id) throw new Error("RPC service missing")
      return new Proxy({}, {
        get: (_target, name: string) => (input: unknown, options?: { signal?: AbortSignal }) => handlers![name](input, {
          signal: options?.signal ?? new AbortController().signal,
          error: (code: string, message: string, data: unknown) => { throw Object.assign(new Error(message), { code, data }) },
        } as never),
      }) as never
    },
    {
      register: async (_definition: unknown, methods: typeof handlers) => {
        handlers = methods
        return { dispose: async () => {} }
      },
    },
  )
  const ctx = { rpc, model: { list: async () => ({ data: [] }) } }
  return {
    register: () => registerQuartermasterRpc(ctx as unknown as Pick<Context, "rpc" | "model">, parseConfig({}), routing as never),
    client: () => ctx.rpc(QUARTERMASTER_RPC) as unknown as Record<string, (input: unknown, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>>,
  }
}

test("rolls closed segment amounts, projections and max statistics into the cumulative row once", async () => {
  const { storage } = fakeStorage()
  const p1 = t0 - 100 * DAY
  const p2 = t0 - 99 * DAY
  const api = (observedAt: number, observedUSD: number | null, projected: number | null) => ({
    currency: "USD" as const,
    basis: "api-equivalent-not-billed" as const,
    observedUSD,
    projectedFullUSD: projected,
    projectionStatus: projected === null ? "unavailable" as const : "estimated" as const,
    reason: projected === null ? "API prices unavailable" : null,
    trackingSince: observedAt - 20 * MIN,
    observedAt,
    spanMs: 20 * MIN,
    quotaDeltaPercent: 10,
    records: 1, pricedRecords: 1, unpricedRecords: 0, partialRecords: 0,
    complete: false as const,
  })
  const resetSnapshot = { event: "reset" as const, segmentID: "qseg:old", capturedAt: p2, value: api(p1, 12.5, 125) }
  const maxSnapshot = { event: "maxed" as const, segmentID: "qseg:new", capturedAt: p2, value: api(p2, 20, 200) }
  const ready = (value: ReturnType<typeof api>, snapshots: Array<typeof resetSnapshot | typeof maxSnapshot>) => ({
    apiValue: value, apiValueSnapshots: snapshots, commit: () => {},
  })
  const values = {
    valueFor: (_sourceID: string, _windowName: string, at: number) => {
      if (at === p1) return ready(api(p1, 10, 100), [])
      if (at === p2) return ready(api(p2, 20, 200), [resetSnapshot, maxSnapshot])
      return undefined
    },
  }
  const history = new QuotaHistory(storage, () => t0)
  const estimates = new QuotaEstimates()
  const first = usageAt(p1, 40)
  const second = usageAt(p2, 50)
  estimates.observe(first, p1)
  await history.record(first, estimates, p1, undefined, values)
  estimates.observe(second, p2)
  await history.record(second, estimates, p2, undefined, values)

  await history.compact(t0)
  const page = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  const totals = page.cumulative?.apiValue
  assert.ok(totals)
  assert.equal(totals.closedResetSegments, 1)
  assert.equal(totals.closedObservedUSD, 12.5)
  // The frozen snapshot is approximate (complete:false), so a numeric subtotal
  // never advertises a complete closed-segment total.
  assert.equal(totals.closedObservedUSDComplete, false)
  assert.equal(totals.maxedSnapshots, 1)
  assert.equal(totals.apiValuePoints, 2)
  assert.equal(totals.estimatedProjections, 2)
  assert.equal(totals.projectedMinUSD, 100)
  assert.equal(totals.projectedMaxUSD, 200)
  // Retrying the fold does not add the closed segment amount twice.
  await history.compact(t0)
  const again = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(again.cumulative?.apiValue?.closedObservedUSD, 12.5)
})

test("a newer observation after a failed head write repairs the head instead of replaying a boundary", async () => {
  let failHead = false
  const { storage } = fakeStorage({
    failSet: (key) => failHead && key.startsWith("routing/quota-history-v1/series/"),
  })
  const history = new QuotaHistory(storage, () => t0 + 5 * MIN)
  const estimates = new QuotaEstimates()
  const value = (observedAt: number, observedUSD: number) => ({
    currency: "USD" as const,
    basis: "api-equivalent-not-billed" as const,
    observedUSD,
    projectedFullUSD: observedUSD * 10,
    projectionStatus: "estimated" as const,
    reason: null,
    trackingSince: observedAt - 20 * MIN,
    observedAt,
    spanMs: 20 * MIN,
    quotaDeltaPercent: 10,
    records: 1, pricedRecords: 1, unpricedRecords: 0, partialRecords: 0,
    complete: false as const,
  })
  const values = {
    valueFor: (_sourceID: string, _windowName: string, at: number) => ({
      apiValue: value(at, at === t0 - 10 * MIN ? 0.5 : at === t0 ? 1 : 2),
      apiValueSnapshots: [],
      commit: () => {},
    }),
  }

  const previous = usageAt(t0 - 10 * MIN, 50)
  estimates.observe(previous, t0 - 10 * MIN)
  await history.record(previous, estimates, t0 - 10 * MIN, undefined, values)

  failHead = true
  const orphan = usageAt(t0, 40)
  estimates.observe(orphan, t0)
  await assert.rejects(history.record(orphan, estimates, t0, undefined, values))
  failHead = false

  const newer = usageAt(t0 + 5 * MIN, 45)
  estimates.observe(newer, t0 + 5 * MIN)
  assert.equal(await history.record(newer, estimates, t0 + 5 * MIN, undefined, values), true)

  const page = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(page.points.length, 3)
  assert.deepEqual(page.points.map((point) => point.cycleBoundary), [false, true, false])
  assert.equal(page.points[1].apiValue?.observedUSD, 1)
  assert.equal(page.points[2].apiValue?.observedUSD, 2)
})

test("drops a malformed archived api value without deleting or poisoning the archive", async () => {
  const { storage, map } = fakeStorage()
  const history = new QuotaHistory(storage, () => t0)
  const estimates = new QuotaEstimates()
  await record(history, estimates, usageAt(t0, 40), t0)
  const at = t0 - 5 * MIN
  map.set(pointKeyFor("go", "weekly", at), {
    ...storedPoint("go", "weekly", at),
    apiValue: {
      currency: "EUR", basis: "api-equivalent-not-billed", observedUSD: 1,
      projectedFullUSD: 10, projectionStatus: "estimated", reason: null,
      trackingSince: at - MIN, observedAt: at, spanMs: MIN, quotaDeltaPercent: 5,
      records: 1, pricedRecords: 1, unpricedRecords: 0, partialRecords: 0, complete: false,
    },
  })
  const page = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(page.points.length, 2)
  const malformed = page.points.find((point) => point.observedAt === at)
  assert.ok(malformed)
  assert.equal(malformed.apiValue, undefined)
  assert.equal(map.has(pointKeyFor("go", "weekly", at)), true)
  assert.equal(page.cumulative, null)
})

test("head repair runs before lazy valuation so a reset is not replayed", async () => {
  let failHead = false
  const { storage } = fakeStorage({
    failSet: (key) => failHead && key.startsWith("routing/quota-history-v1/series/"),
  })
  const config = parseConfig({
    usageSources: { openai: "codex" },
    tokenRates: [{
      providerID: "openai", modelID: "m", inputPerMillion: 10, outputPerMillion: 20,
      currency: "USD", source: "test", asOf: 1,
    }],
  })
  const tracker = new QuotaValueTracker(config)
  const history = new QuotaHistory(storage, () => t0 + 25 * MIN)
  const estimates = new QuotaEstimates()
  const observe = async (at: number, percent: number) => {
    const usage = usageAt(at, percent, { sourceID: "codex" })
    estimates.observe(usage, at)
    const plan = await tracker.prepare(usage, at, new Map())
    return history.record(usage, estimates, at, undefined, plan)
  }
  await observe(t0, 20)
  tracker.addTokenRecord({
    hostContractVersion: "2.0.18", hostEventID: "event", sourceEvent: "session.step.ended",
    hostSessionID: "s", hostMessageID: "m", hostProjectID: "p", parentSessionID: null,
    hostAgentID: null, providerID: "openai", modelID: "m", variant: null,
    completedAt: t0 + 5 * MIN, counts: { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    usageStatus: "reported", partial: false,
  } as never)
  await observe(t0 + 10 * MIN, 25)
  failHead = true
  await assert.rejects(observe(t0 + 16 * MIN, 2))
  failHead = false
  await observe(t0 + 21 * MIN, 5)

  const page = await history.query({ sourceID: "codex", windowName: "weekly" }) as QuotaHistoryResult
  const resets = page.points.flatMap((point) => point.apiValueSnapshots ?? []).filter((snapshot) => snapshot.event === "reset")
  assert.equal(resets.length, 1)
  const last = page.points[page.points.length - 1]
  assert.equal(last.observedAt, t0 + 21 * MIN)
  assert.equal(last.apiValueSnapshots?.length ?? 0, 0)
  assert.equal(last.apiValue?.trackingSince, t0 + 16 * MIN)
})

test("status suppresses frozen dollars when a newer observation could not be archived", async () => {
  let failPoints = false
  const { storage } = fakeStorage({
    failSet: (key) => failPoints && key.startsWith("routing/quota-history-v1/points/"),
  })
  const config = parseConfig({ usageSources: { openai: "codex" } })
  const tracker = new QuotaValueTracker(config)
  const now = Date.now()
  const firstAt = now - 2_000
  const secondAt = now - 1_000
  const rawUsage = (at: number, percent: number) => ({
    schemaVersion: 1,
    updatedAt: new Date(at).toISOString(),
    models: { go: {} },
    sources: Object.fromEntries(["go", "codex", "cursor"].map((id) => [id, {
      authenticated: true, checkedAt: new Date(at).toISOString(), stale: false, error: null,
      windows: id === "codex" ? [{ name: "weekly", usedPercent: percent, state: "ok", resetsAt: null }] : [],
      nextAvailableAt: null, availability: "available",
    }])),
  })
  let rawAt = firstAt
  let rawPercent = 50
  let current = usageAt(firstAt, 50, { sourceID: "codex" })
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: [{ providerID: "openai", id: "model-a", enabled: true }] }) },
    storage,
    rpc: () => ({ status: async () => rawUsage(rawAt, rawPercent) }),
    agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
  } as never, config, current, undefined, undefined, tracker)
  assert.ok(routing)
  try {
    const first = await routing.status() as { sources: Record<string, { windows: Array<{ apiValue?: { observedAt: number } }> }> }
    assert.equal(first.sources.openai.windows[0].apiValue?.observedAt, firstAt)

    rawAt = secondAt
    rawPercent = 55
    current = usageAt(secondAt, 55, { sourceID: "codex" })
    failPoints = true
    await routing.refresh()
    const second = await routing.status() as { sources: Record<string, { windows: Array<{ usedPercent: number; apiValue?: unknown }> }> }
    assert.equal(second.sources.openai.windows[0].usedPercent, 55)
    assert.equal(second.sources.openai.windows[0].apiValue, undefined)
  } finally {
    await routing.dispose()
  }
})
