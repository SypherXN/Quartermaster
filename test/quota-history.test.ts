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
import { QuotaValueTracker, VALUE_REASON_RESTARTED, type QuotaApiValue } from "../src/quota-values.ts"
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
  failScan?: (prefix: string) => boolean
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
      if (options.failScan?.(prefix)) throw new Error("scan failed")
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

const claudeWindows = (percent: number): UsageWindow[] => [
  { name: "5h", usedPercent: percent, state: "ok", resetsAt: null },
  { name: "7d", usedPercent: 47, state: "ok", resetsAt: null },
]

function claudeFixture(storage: never) {
  const config = parseConfig({ usageSources: { "claude-agent": "claude-agent" } })
  // A fresh set of objects over the same storage is a plugin restart.
  const start = () => {
    const tracker = new QuotaValueTracker(config)
    const history = new QuotaHistory(storage, () => t0)
    const estimates = new QuotaEstimates()
    const observe = async (at: number, percent: number, now = at) => {
      const usage = usageAt(at, percent, { sourceID: "claude-agent", windows: claudeWindows(percent) })
      estimates.observe(usage, now)
      const plan = await tracker.prepare(usage, now, new Map())
      return history.record(usage, estimates, now, new Set(["claude-agent"]), plan)
    }
    return { tracker, history, observe }
  }
  return { start }
}

test("a restarted process seeds a window from the observation clock already in the archive", async () => {
  const { storage, map } = fakeStorage()
  const fixture = claudeFixture(storage)
  const first = fixture.start()
  assert.equal(await first.observe(t0, 10), true)
  const stored = structuredClone(map.get(pointKeyFor("claude-agent", "5h", t0))) as { apiValue?: unknown }
  assert.ok(stored.apiValue, "the first process archived a value")

  // Restart: the usage source re-reports the same checkedAt, so no new point is written.
  const second = fixture.start()
  assert.equal(second.tracker.latestValue("claude-agent", "5h"), undefined)
  assert.equal(await second.observe(t0, 10, t0 + 3 * MIN), false)
  for (const name of ["5h", "7d"]) {
    assert.equal(second.tracker.latestValue("claude-agent", name)?.observedAt, t0, `${name} is valued after restart`)
  }
  assert.equal(pointKeys(map).length, 2, "no duplicate point")
  assert.deepEqual(map.get(pointKeyFor("claude-agent", "5h", t0)), stored, "an archived value is never rewritten")

  // The seed is committed but uncorroborated: the token buffer was not live at the
  // seeded clock, so the next fresh observation reanchors (reason: restarted)
  // instead of pairing the full quota delta with an undercounted spend.
  assert.equal(second.tracker.latestValue("claude-agent", "5h")?.reason, VALUE_REASON_RESTARTED)
  assert.equal(await second.observe(t0 + 5 * MIN, 11), true)
  assert.equal(await second.observe(t0 + 10 * MIN, 12), true)
  const page = await second.history.query({ sourceID: "claude-agent", windowName: "5h" }) as QuotaHistoryResult
  assert.equal(page.points.length, 3)
  assert.equal(page.points[1].apiValue?.reason, VALUE_REASON_RESTARTED)
  assert.equal(page.points[1].apiValue?.trackingSince, t0 + 5 * MIN)
  assert.equal(page.points[1].apiValue?.spanMs, 0)
  assert.equal(page.points[2].apiValue?.trackingSince, t0 + 5 * MIN)
  assert.equal(page.points[2].apiValue?.spanMs, 5 * MIN)
})

test("a cached clock is seeded once and never rewrites the point on later reads", async () => {
  const { storage, map } = fakeStorage()
  const fixture = claudeFixture(storage)
  const first = fixture.start()
  await first.observe(t0, 10)
  const second = fixture.start()
  await second.observe(t0, 10, t0 + MIN)
  const before = structuredClone(map.get(pointKeyFor("claude-agent", "7d", t0)))
  const latest = second.tracker.latestValue("claude-agent", "7d")
  await second.observe(t0, 10, t0 + 2 * MIN)
  await second.observe(t0, 10, t0 + 3 * MIN)
  assert.deepEqual(map.get(pointKeyFor("claude-agent", "7d", t0)), before)
  assert.deepEqual(second.tracker.latestValue("claude-agent", "7d"), latest)
})

test("an archived point written before values existed gains its apiValue and the tracker is committed", async () => {
  const { storage, map } = fakeStorage()
  for (const name of ["5h", "7d"]) seedSeries(map, "claude-agent", name, [t0])
  const { tracker, history, observe } = claudeFixture(storage).start()
  assert.equal(await observe(t0, 50), false)
  for (const name of ["5h", "7d"]) {
    assert.equal(tracker.latestValue("claude-agent", name)?.observedAt, t0)
  }
  const page = await history.query({ sourceID: "claude-agent", windowName: "5h" }) as QuotaHistoryResult
  assert.equal(page.points.length, 1)
  assert.equal(page.points[0].apiValue?.observedAt, t0)
  assert.equal(page.points[0].apiValue?.trackingSince, t0)
})

test("a point that survived a crash is reused and still commits the tracker", async () => {
  const { storage, map } = fakeStorage()
  for (const name of ["5h", "7d"]) {
    seedSeries(map, "claude-agent", name, [t0 - 10 * MIN])
    // The point landed but the head write never did.
    map.set(pointKeyFor("claude-agent", name, t0), storedPoint("claude-agent", name, t0))
  }
  const { tracker, history, observe } = claudeFixture(storage).start()
  assert.equal(await observe(t0, 50), false)
  for (const name of ["5h", "7d"]) {
    assert.equal(tracker.latestValue("claude-agent", name)?.observedAt, t0)
  }
  const page = await history.query({ sourceID: "claude-agent", windowName: "7d" }) as QuotaHistoryResult
  assert.equal(page.points.length, 2)
  assert.equal(page.points[1].observedAt, t0)
  assert.equal(page.points[1].apiValue?.observedAt, t0)
  // The reused point is a seed, so the next observation reanchors rather than
  // trusting a buffer that was not live when that point was written.
  assert.equal(await observe(t0 + 5 * MIN, 51), true)
  const next = await history.query({ sourceID: "claude-agent", windowName: "7d" }) as QuotaHistoryResult
  assert.equal(next.points[2].apiValue?.trackingSince, t0 + 5 * MIN)
  assert.equal(next.points[2].apiValue?.reason, VALUE_REASON_RESTARTED)
})

test("a window with no plan this read stays unseeded and is valued on the next read", async () => {
  const { storage, map } = fakeStorage()
  for (const name of ["5h", "7d"]) seedSeries(map, "claude-agent", name, [t0])
  const config = parseConfig({ usageSources: { "claude-agent": "claude-agent" } })
  const tracker = new QuotaValueTracker(config)
  const history = new QuotaHistory(storage, () => t0)
  const estimates = new QuotaEstimates()
  const usage = usageAt(t0, 50, { sourceID: "claude-agent", windows: claudeWindows(50) })
  estimates.observe(usage, t0)
  await history.record(usage, estimates, t0, new Set(["claude-agent"]), undefined)
  assert.equal(tracker.latestValue("claude-agent", "5h"), undefined)
  await history.record(usage, estimates, t0, new Set(["claude-agent"]), await tracker.prepare(usage, t0, new Map()))
  assert.equal(tracker.latestValue("claude-agent", "5h")?.observedAt, t0)
})

test("a same-clock seed never rewrites a stored apiValue and is not repeated on later reads", async () => {
  const { storage, map } = fakeStorage()
  seedSeries(map, "go", "weekly", [t0])
  const apiValue = (observedUSD: number) => ({
    currency: "USD" as const,
    basis: "api-equivalent-not-billed" as const,
    observedUSD,
    projectedFullUSD: observedUSD * 10,
    projectionStatus: "estimated" as const,
    reason: null,
    trackingSince: t0 - 20 * MIN,
    observedAt: t0,
    spanMs: 20 * MIN,
    quotaDeltaPercent: 10,
    records: 1, pricedRecords: 1, unpricedRecords: 0, partialRecords: 0,
    complete: false as const,
  })
  map.set(pointKeyFor("go", "weekly", t0), { ...storedPoint("go", "weekly", t0), apiValue: apiValue(5) })
  const before = structuredClone(map.get(pointKeyFor("go", "weekly", t0)))
  let seeds = 0
  let commits = 0
  const values = {
    valueFor: (_sourceID: string, _windowName: string, _at: number, options?: { seed?: boolean }) => {
      if (options?.seed === true) seeds += 1
      return { apiValue: apiValue(7), apiValueSnapshots: [], commit: () => { commits += 1 } }
    },
  }
  const history = new QuotaHistory(storage, () => t0)
  const estimates = new QuotaEstimates()
  const usage = usageAt(t0, 50)
  estimates.observe(usage, t0)
  for (let read = 0; read < 3; read += 1) {
    assert.equal(await history.record(usage, estimates, t0 + read * MIN, undefined, values), false)
  }
  assert.equal(seeds, 1, "the cached clock is seeded exactly once")
  assert.equal(commits, 1, "the tracker is committed exactly once")
  assert.deepEqual(map.get(pointKeyFor("go", "weekly", t0)), before, "the stored point is not rewritten")
  assert.equal(pointKeys(map).length, 1, "no duplicate point")
})

// ---- closed-window archive ----
const windowKeyFor = (sourceID: string, windowName: string, at: number) =>
  `routing/quota-history-v1/windows/${encodeURIComponent(JSON.stringify([sourceID, windowName]))}/${String(at).padStart(16, "0")}`
const windowKeys = (map: Map<string, unknown>) =>
  [...map.keys()].filter((key) => key.startsWith("routing/quota-history-v1/windows/"))

test("one durable current checkpoint retains its observed anchor through moves, restarts and compaction", async () => {
  const { storage, map } = fakeStorage()
  const { record: rec, windows } = windowHarness(storage)
  let history = new QuotaHistory(storage, () => t0 + DAY)
  for (let i = 0; i < 20; i++) {
    const at = t0 + i * MIN
    await rec(history, at, 40 + i, { resetsAt: t0 + DAY + i * MIN, resetEstimated: i % 2 === 0 })
    const before = structuredClone([...map])
    const current = await history.currentCheckpoint("go", "weekly", at)
    assert.equal(current?.instanceAnchorAt, t0)
    assert.equal(current?.apiValue?.observedAt, at)
    assert.deepEqual([...map], before, "checkpoint reads never persist or maintain")
    history = new QuotaHistory(storage, () => t0 + DAY)
  }
  assert.equal([...map.keys()].filter((key) => key.startsWith("routing/quota-history-v1/series/")).length, 1)
  assert.equal(await history.currentCheckpoint("codex", "weekly", t0 + 19 * MIN), undefined)
  assert.equal(await history.currentCheckpoint("go", "weekly", t0), undefined)
  await rec(history, t0 + 20 * MIN, 1)
  const row = (await windows(history)).windows![0]
  assert.equal(row.instanceAnchorAt, t0)
  assert.equal((await history.currentCheckpoint("go", "weekly", t0 + 20 * MIN))?.instanceAnchorAt, t0 + 20 * MIN)
  const frozen = structuredClone(map.get(windowKeyFor("go", "weekly", t0 + 19 * MIN)))
  await history.compact(t0 + 100 * DAY)
  assert.equal(pointKeys(map).length, 0)
  assert.equal((await history.currentCheckpoint("go", "weekly", t0 + 20 * MIN))?.apiValue?.observedAt, t0 + 20 * MIN)
  assert.deepEqual(map.get(windowKeyFor("go", "weekly", t0 + 19 * MIN)), frozen)
})

test("checkpoint visibility follows durable head writes and pending closures through rebound repair", async () => {
  for (const stage of ["windows", "points", "series"]) {
    let fail = false
    const { storage, map } = fakeStorage({ failSet: (key) => fail && key.startsWith(`routing/quota-history-v1/${stage}/`) })
    const { record: rec, windows } = windowHarness(storage)
    let history = new QuotaHistory(storage, () => t0 + DAY)
    await rec(history, t0, 50)
    fail = true
    await assert.rejects(rec(history, t0 + MIN, 2))
    assert.equal(await history.currentCheckpoint("go", "weekly", t0 + MIN), undefined, stage)
    if (stage === "points") assert.equal(await history.currentCheckpoint("go", "weekly", t0), undefined, "closed before point")
    fail = false
    history = new QuotaHistory(storage, () => t0 + DAY)
    await rec(history, t0 + 2 * MIN, 60) // rebound: row, point and repair are separate durable checkpoints
    const expectedAnchor = stage === "series" ? t0 + MIN : stage === "points" ? t0 + 2 * MIN : t0
    assert.equal((await history.currentCheckpoint("go", "weekly", t0 + 2 * MIN))?.instanceAnchorAt, expectedAnchor)
    assert.equal((await windows(history)).windows!.length, stage === "windows" ? 0 : 1)
    assert.equal(windowKeys(map).length, stage === "windows" ? 0 : 1)
  }
})

test("checkpoint seed failures retry, corrupt optional money is stripped, and legacy frozen rows are never upgraded", async () => {
  let fail = false
  const { storage, map } = fakeStorage({ failSet: (key) => fail && key.startsWith("routing/quota-history-v1/series/") })
  seedSeries(map, "go", "weekly", [t0])
  const { record: rec, windows } = windowHarness(storage)
  const history = new QuotaHistory(storage, () => t0 + DAY)
  fail = true
  await rec(history, t0, 50)
  assert.equal((await history.currentCheckpoint("go", "weekly", t0))?.apiValue, undefined)
  fail = false
  await rec(history, t0, 50)
  assert.equal((await history.currentCheckpoint("go", "weekly", t0))?.apiValue?.projectedFullUSD, usdAt(t0) * 10)
  const head = map.get(seriesKeyFor("go", "weekly")) as Record<string, unknown>
  map.set(seriesKeyFor("go", "weekly"), { ...head, currentValue: { ...apiAt(t0, 0), observedAt: t0 + 1 } })
  assert.equal((await history.currentCheckpoint("go", "weekly", t0))?.apiValue, undefined)
  const old = { version: 1, sourceID: "go", windowName: "weekly", lastObservedAt: t0 - MIN, nextObservedAt: t0,
    lastPercent: 50, nextPercent: 10, resetsAt: null, nextResetsAt: null, resetEstimated: false, deadlineCrossed: false }
  map.set(windowKeyFor("go", "weekly", t0 - MIN), old)
  const row = (await windows(history)).windows![0]
  assert.equal(row.instanceAnchorAt, undefined)
  assert.equal(row.finalEstimateReason, "No estimate recorded")
  assert.deepEqual(map.get(windowKeyFor("go", "weekly", t0 - MIN)), old)
})

test("two overlapping current windows recover without repricing; closure freezes the last valid projection", async (t) => {
  let now = t0
  t.mock.method(Date, "now", () => now)
  const config = parseConfig({ fetchApiPrices: false, usageSources: { openai: "codex", other: "go" }, tokenRates: [
    { providerID: "openai", modelID: "m", inputPerMillion: 1, outputPerMillion: 1, currency: "USD", source: "test", asOf: 1 },
    { providerID: "other", modelID: "m", inputPerMillion: 1, outputPerMillion: 1, currency: "USD", source: "test", asOf: 1 },
  ] })
  const { storage, map } = fakeStorage()
  let tracker = new QuotaValueTracker(config, t0)
  let history = new QuotaHistory(storage, () => now)
  const estimates = new QuotaEstimates()
  const data = (at: number, short: number, long: number) => usageAt(at, short, { sourceID: "codex", windows: [
    { name: "5h", usedPercent: short, state: "ok", resetsAt: null },
    { name: "7d", usedPercent: long, state: "ok", resetsAt: null },
  ] })
  const observe = async (at: number, short: number, long: number) => {
    now = at
    const usage = data(at, short, long)
    estimates.observe(usage, at)
    await history.record(usage, estimates, at, undefined, await tracker.prepare(usage, at, new Map()))
  }
  const token = (id: string, at: number, provider = "openai", input = 1_000_000) => ({
    hostEventID: id, completedAt: at, providerID: provider, modelID: "m", variant: null,
    counts: { input, output: 0, cacheRead: 0, cacheWrite: 0 }, partial: false, usageStatus: "reported",
  } as never)
  await observe(t0, 20, 30)
  tracker.addTokenRecord(token("one", t0 + 5 * MIN))
  tracker.addTokenRecord(token("other-source", t0 + 5 * MIN, "other", 9_000_000))
  await observe(t0 + 10 * MIN, 25, 32)
  await observe(t0 + 20 * MIN, 30, 34)
  const short = (await history.currentCheckpoint("codex", "5h", now))!
  const long = (await history.currentCheckpoint("codex", "7d", now))!
  assert.equal(short.apiValue?.projectedFullUSD, 10)
  assert.equal(long.apiValue?.projectedFullUSD, 25)
  assert.equal(short.instanceAnchorAt, t0)
  assert.equal(long.instanceAnchorAt, t0)
  tracker = new QuotaValueTracker(config, now + 1)
  history = new QuotaHistory(storage, () => now)
  config.tokenRates![0].inputPerMillion = 10 // Must not reprice the recovered clock.
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: [] }) }, storage,
    rpc: () => ({ status: async () => { throw new Error("not needed") } }),
    agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
  } as never, config, data(now, 30, 34), undefined, undefined, tracker)
  try {
    const status = await routing!.status() as any
    assert.deepEqual(status.sources.openai.windows[0].apiValue, short.apiValue)
    assert.equal(status.sources.openai.windows[0].instanceAnchorAt, t0)
    now += 6 * MIN
    assert.equal((await routing!.status() as any).sources.openai.windows[0].apiValue, undefined)
  } finally { await routing!.dispose() }
  await observe(t0 + 27 * MIN, 32, 35)
  assert.equal((await history.currentCheckpoint("codex", "5h", now))?.apiValue?.reason, VALUE_REASON_RESTARTED)
  await observe(t0 + 30 * MIN, 1, 36)
  const key = windowKeyFor("codex", "5h", t0 + 27 * MIN)
  const frozen = structuredClone(map.get(key))
  assert.deepEqual((frozen as any).finalEstimate, short.apiValue)
  assert.equal((await history.currentCheckpoint("codex", "5h", now))?.instanceAnchorAt, now)
  assert.equal((await history.currentCheckpoint("codex", "7d", now))?.instanceAnchorAt, t0)
  tracker.addTokenRecord(token("late", t0 + 10 * MIN, "openai", 100_000_000))
  tracker.removeTokenRecords([token("one", t0 + 5 * MIN)])
  config.tokenRates![0].inputPerMillion = 100
  await observe(t0 + 35 * MIN, 2, 37)
  assert.deepEqual(map.get(key), frozen)
  assert.equal((await history.currentCheckpoint("codex", "5h", now))?.apiValue?.observedUSD, null)
})

// Distinct per observation minute, so a row can prove which point it copied.
const usdAt = (at: number) => Math.floor(at / MIN) % 997 + 1
const apiAt = (observedAt: number, observedUSD: number) => ({
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
const unavailableAt = (at: number): QuotaApiValue => ({
  ...apiAt(at, 1), projectedFullUSD: null, projectionStatus: "unavailable", reason: "API prices unavailable",
})
const maxedAt = (at: number) => ({ event: "maxed" as const, segmentID: `qseg:${at}`, capturedAt: at, value: apiAt(at, usdAt(at)) })

function windowHarness(storage: never, snapshots: Record<number, unknown[]> = {}, apiValues: Record<number, QuotaApiValue> = {}) {
  const estimates = new QuotaEstimates()
  const values = {
    valueFor: (_sourceID: string, _windowName: string, at: number) => ({
      apiValue: apiValues[at] ?? apiAt(at, usdAt(at)), apiValueSnapshots: snapshots[at] ?? [], commit: () => {},
    }),
  }
  const record = (history: QuotaHistory, at: number, percent: number, options: Parameters<typeof usageAt>[2] = {}) => {
    const usage = usageAt(at, percent, options)
    estimates.observe(usage, at)
    return history.record(usage, estimates, at, undefined, values as never)
  }
  const windows = async (history: QuotaHistory, extra: Record<string, unknown> = {}) => {
    const page = await history.query({ kind: "windows", sourceID: "go", windowName: "weekly", ...extra }) as QuotaHistoryResult
    assert.equal(page.status, "ok")
    return page
  }
  return { record, windows, storage }
}

test("a failed previous-point read aborts closure; absent or malformed values stay absent", async () => {
  for (const mode of ["read-failure", "missing", "malformed"] as const) {
    let fail = false
    const { storage, map } = fakeStorage({ failGet: (key) => fail && key === pointKeyFor("go", "weekly", t0) })
    const { record: rec, windows } = windowHarness(storage)
    const history = new QuotaHistory(storage, () => t0 + MIN)
    await rec(history, t0, 70)
    const previous = structuredClone(map.get(pointKeyFor("go", "weekly", t0))) as Record<string, unknown>
    const head = structuredClone(map.get(seriesKeyFor("go", "weekly")))
    if (mode === "read-failure") {
      fail = true
      await assert.rejects(rec(history, t0 + MIN, 2))
      assert.equal(windowKeys(map).length, 0)
      assert.equal(pointKeys(map).length, 1)
      assert.deepEqual(map.get(seriesKeyFor("go", "weekly")), head)
      fail = false
    } else if (mode === "missing") map.delete(pointKeyFor("go", "weekly", t0))
    else map.set(pointKeyFor("go", "weekly", t0), { ...previous, apiValue: { observedUSD: 0 } })
    await rec(history, t0 + MIN, 2)
    const row = (await windows(history)).windows![0]
    if (mode === "read-failure") assert.deepEqual(row.apiValue, previous.apiValue)
    else assert.equal("apiValue" in row, false, mode)
  }
})

test("max alone closes nothing and never decides the window number", async () => {
  const { storage, map } = fakeStorage()
  const hit = t0 + MIN
  const reset = t0 + 3 * MIN
  const { record: rec, windows } = windowHarness(storage, {
    [hit]: [maxedAt(hit)],
    [hit + MIN]: [maxedAt(hit + MIN)], // a restarted tracker reports the limit again
  })
  let history = new QuotaHistory(storage, () => reset)
  await rec(history, t0, 80, { resetsAt: reset })
  await rec(history, hit, 100, { resetsAt: reset })
  history = new QuotaHistory(storage, () => reset)
  await rec(history, hit + MIN, 100, { resetsAt: reset })
  assert.equal(windowKeys(map).length, 0, "reaching the limit, even twice, is not a window boundary")
  await rec(history, reset, 10)
  const rows = (await windows(history)).windows!
  assert.equal(rows.length, 1)
  assert.equal("maxed" in rows[0], false)
  // The number is the last valid estimate before the boundary, not the one at the limit.
  assert.deepEqual(rows[0].finalEstimate, apiAt(hit + MIN, usdAt(hit + MIN)))
  assert.notEqual(rows[0].finalEstimate?.projectedFullUSD, apiAt(hit, usdAt(hit)).projectedFullUSD)
})

test("a projection on a point that survived a failed head write is recovered before a newer reset", async () => {
  let fail = false
  const { storage, map } = fakeStorage({ failSet: (key) => fail && key.startsWith("routing/quota-history-v1/series/") })
  const hit = t0 + MIN
  const { record: rec, windows } = windowHarness(storage)
  let history = new QuotaHistory(storage, () => t0 + 3 * MIN)
  await rec(history, t0, 90)
  fail = true
  await assert.rejects(rec(history, hit, 100))
  fail = false
  history = new QuotaHistory(storage, () => t0 + 3 * MIN)
  await rec(history, t0 + 2 * MIN, 2)
  const rows = (await windows(history)).windows!
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].apiValue, apiAt(hit, usdAt(hit)))
  assert.deepEqual(rows[0].finalEstimate, apiAt(hit, usdAt(hit)))
  assert.equal(windowKeys(map).length, 1)
})

test("a row survives a failed boundary point and a newer retry without being rewritten", async () => {
  let fail = false
  const { storage, map } = fakeStorage({ failSet: (key) => fail && key.startsWith("routing/quota-history-v1/points/") })
  const { record: rec, windows } = windowHarness(storage)
  let history = new QuotaHistory(storage, () => t0 + 3 * MIN)
  await rec(history, t0, 50)
  fail = true
  await assert.rejects(rec(history, t0 + MIN, 2))
  const frozen = structuredClone(map.get(windowKeyFor("go", "weekly", t0)))
  fail = false
  history = new QuotaHistory(storage, () => t0 + 3 * MIN)
  // Definition: a window is closed once its closing row is stored, even if the
  // observation that proved it never became a point. That 2% read is history, so
  // the rebound is the first durable point of the next cycle and the row is frozen.
  assert.equal(await rec(history, t0 + 2 * MIN, 55), true)
  await rec(history, t0 + 3 * MIN, 60)
  assert.deepEqual(map.get(windowKeyFor("go", "weekly", t0)), frozen)
  assert.deepEqual((await windows(history)).windows, [frozen])
  assert.equal((frozen as { nextObservedAt: number }).nextObservedAt, t0 + MIN, "the failed observation proved it")
  const points = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.deepEqual(points.points.map((point) => [point.observedAt, point.cycleBoundary]),
    [[t0, false], [t0 + 2 * MIN, true], [t0 + 3 * MIN, false]])
})

test("50% then a failed 2% then 1% closes exactly one window and the next point is the new cycle", async () => {
  let fail = false
  const { storage, map } = fakeStorage({ failSet: (key) => fail && key.startsWith("routing/quota-history-v1/points/") })
  const { record: rec, windows } = windowHarness(storage)
  let history = new QuotaHistory(storage, () => t0 + 5 * MIN)
  await rec(history, t0, 50)
  fail = true
  await assert.rejects(rec(history, t0 + MIN, 2))
  fail = false
  history = new QuotaHistory(storage, () => t0 + 5 * MIN)
  assert.equal(await rec(history, t0 + 2 * MIN, 1), true)
  assert.equal(await rec(history, t0 + 3 * MIN, 3), true)
  assert.equal(windowKeys(map).length, 1)
  const row = (await windows(history)).windows![0]
  assert.equal(row.lastObservedAt, t0)
  assert.equal(row.nextPercent, 2)
  const points = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.deepEqual(points.points.map((point) => point.cycleBoundary), [false, true, false])
})

test("closed-window queries page and range by lastObservedAt, skip malformed rows, and never compact", async () => {
  const { storage, map } = fakeStorage({ pageSize: 1 })
  const { record: rec, windows } = windowHarness(storage)
  const history = new QuotaHistory(storage, () => t0 + 100 * DAY)
  for (const [i, percent] of [90, 80, 70, 60].entries()) await rec(history, t0 + i * MIN, percent)
  const original = structuredClone(map)
  const first = (original.get(windowKeyFor("go", "weekly", t0))) as Record<string, unknown>
  const badKey = windowKeyFor("go", "weekly", t0 - 1)
  map.set(badKey, { ...first, lastObservedAt: t0 - 1, nextObservedAt: t0 - 2 })
  const wrongKey = windowKeyFor("go", "weekly", t0 - 2)
  map.set(wrongKey, first)
  // Poison the fold checkpoint: window queries must not even try compaction.
  map.set(cumulativeKeyFor("go", "weekly"), { version: 1, broken: true })
  const before = structuredClone(map)
  const one = await windows(history, { limit: 1 })
  assert.equal(one.windows?.length, 1)
  assert.equal(one.windows?.[0].lastObservedAt, t0)
  assert.equal(one.nextCursor, String(t0))
  const two = await windows(history, { limit: 1, cursor: one.nextCursor })
  assert.equal(two.windows?.[0].lastObservedAt, t0 + MIN)
  assert.equal(two.nextCursor, String(t0 + MIN))
  const three = await windows(history, { limit: 1, cursor: two.nextCursor })
  assert.equal(three.windows?.[0].lastObservedAt, t0 + 2 * MIN)
  assert.equal(three.nextCursor, null)
  assert.deepEqual((await windows(history, { from: t0 + MIN, to: t0 + MIN })).windows, two.windows)
  assert.deepEqual((await windows(history, { from: t0 + 3 * MIN })).windows, [])
  assert.deepEqual((await windows(history, { cursor: String(Number.MAX_SAFE_INTEGER) })).windows, [])
  assert.deepEqual(map, before, "no maintenance, mutation, or deletion")
})

test("windows RPC validates kind and bounds and uses the existing method", async () => {
  const query = { kind: "windows", sourceID: "go", windowName: "weekly", from: 1, to: 2, limit: 1, cursor: "0" }
  assert.deepEqual(quotaHistoryQueryFromInput(query), { ok: true, query })
  assert.deepEqual(quotaHistoryQueryFromInput({ kind: "points" }), { ok: true, query: {} })
  const { storage } = fakeStorage()
  const history = new QuotaHistory(storage, () => t0)
  const fixture = rpcFixture({ quotaHistory: (input: never) => history.query(input) })
  await fixture.register()
  const result = await fixture.client().quotaHistory(query)
  assert.equal(result.apiVersion, 1)
  assert.equal(result.status, "ok")
  assert.deepEqual(result.windows, [])
  for (const invalid of [
    { kind: "windows" }, { kind: "windows", sourceID: "go" },
    { ...query, kind: "closed" }, { ...query, kind: null },
    { ...query, from: 3 }, { ...query, to: NaN },
    { ...query, from: Number.MAX_SAFE_INTEGER + 1 },
    { ...query, limit: 1_001 }, { ...query, cursor: "01" },
    { ...query, cursor: "9007199254740992" }, { ...query, catalogCursor: "x" },
  ]) {
    assert.equal(quotaHistoryQueryFromInput(invalid).ok, false)
    await assert.rejects(fixture.client().quotaHistory(invalid), { code: "invalid_input" })
  }
})

test("closed windows use the previous durable value even when the tracker restarts at reset", async () => {
  const { storage, map } = fakeStorage()
  const fixture = claudeFixture(storage)
  const first = fixture.start()
  await first.observe(t0, 80)
  const previous = structuredClone(map.get(pointKeyFor("claude-agent", "5h", t0))) as { apiValue: unknown }
  const second = fixture.start()
  await second.observe(t0 + MIN, 2)
  const page = await second.history.query({ kind: "windows", sourceID: "claude-agent", windowName: "5h" }) as QuotaHistoryResult
  assert.equal(page.windows?.length, 1)
  assert.deepEqual(page.windows?.[0].apiValue, previous.apiValue)
  assert.equal(page.windows?.[0].deadlineCrossed, false)
  assert.deepEqual(map.get(pointKeyFor("claude-agent", "5h", t0)), previous)
})

test("window scan failure returns unavailable rather than an empty archive", async () => {
  const { storage } = fakeStorage({ failScan: (prefix) => prefix.startsWith("routing/quota-history-v1/windows/") })
  assert.deepEqual(await new QuotaHistory(storage).query({ kind: "windows", sourceID: "go", windowName: "weekly" }), {
    status: "unavailable", reason: "storage-unavailable",
  })
})

test("a closed window survives a restart and the 90-day fold exactly once, with its evidence", async () => {
  const { storage, map } = fakeStorage()
  let clock = t0
  const old = t0 - 100 * DAY
  const { record: rec, windows } = windowHarness(storage)
  let history = new QuotaHistory(storage, () => clock)
  await rec(history, old, 40, { resetsAt: old + 60 * MIN })
  assert.equal(windowKeys(map).length, 0, "the first observation closes nothing")
  // A bare percentage drop: inferred, a rolling window does this without any reset.
  assert.equal(await rec(history, old + 10 * MIN, 30, { resetsAt: old + 60 * MIN }), true)
  history = new QuotaHistory(storage, () => clock) // restart
  assert.equal(await rec(history, old + 10 * MIN, 30, { resetsAt: old + 60 * MIN }), false)
  assert.equal(await rec(history, old + 20 * MIN, 35, { resetsAt: old + 60 * MIN }), true)
  // The reported deadline falls between two observations with no drop: real evidence.
  assert.equal(await rec(history, old + 70 * MIN, 36, { resetsAt: old + 120 * MIN, resetEstimated: true }), true)
  assert.equal(await rec(history, old + 71 * MIN, 37, { resetsAt: old + 120 * MIN, resetEstimated: true }), true)
  assert.equal(windowKeys(map).length, 2)

  const before = await windows(history)
  assert.deepEqual(before.points, [])
  assert.deepEqual(before.catalog, [])
  assert.equal(before.cumulative, null)
  assert.equal(before.nextCursor, null)
  assert.equal(before.metadata.rangeAppliesTo, "windows")
  const [inferred, crossed] = before.windows!
  assert.deepEqual(inferred, {
    version: 1, sourceID: "go", windowName: "weekly",
    lastObservedAt: old, nextObservedAt: old + 10 * MIN,
    instanceAnchorAt: old,
    lastPercent: 40, nextPercent: 30,
    resetsAt: old + 60 * MIN, resetEstimated: false, nextResetsAt: old + 60 * MIN,
    deadlineCrossed: false,
    apiValue: apiAt(old, usdAt(old)),
    finalEstimate: apiAt(old, usdAt(old)),
  })
  assert.equal(crossed.deadlineCrossed, true)
  assert.equal(crossed.resetEstimated, false, "the closed window's own deadline was not estimated")
  assert.equal(crossed.lastObservedAt, old + 20 * MIN)
  assert.equal(crossed.nextObservedAt, old + 70 * MIN)
  assert.equal(crossed.resetsAt, old + 60 * MIN)
  assert.equal(crossed.nextResetsAt, old + 120 * MIN)
  assert.equal(crossed.nextPercent, 36)
  assert.equal(crossed.apiValue?.observedUSD, usdAt(old + 20 * MIN))

  // Everything raw is now older than 90 days: points fold, closed windows stay.
  const rows = windowKeys(map).map((key) => structuredClone(map.get(key)))
  const points = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(points.points.length, 0)
  assert.equal(points.cumulative?.observations, 5)
  assert.equal("windows" in points, false, "the default points response is unchanged")
  assert.equal(pointKeys(map).length, 0)
  assert.deepEqual(windowKeys(map).map((key) => map.get(key)), rows)
  clock += DAY
  await history.compact(clock)
  assert.deepEqual((await windows(history)).windows, before.windows)
})

test("a failed row, point or head write around a boundary retries onto exactly one frozen row", async () => {
  for (const failing of ["windows", "points", "series"] as const) {
    let fail = false
    const { storage, map } = fakeStorage({
      failSet: (key) => fail && key.startsWith(`routing/quota-history-v1/${failing}/`),
    })
    const { record: rec, windows } = windowHarness(storage)
    const history = new QuotaHistory(storage, () => t0 + 30 * MIN)
    await rec(history, t0, 50)
    fail = true
    await assert.rejects(rec(history, t0 + 10 * MIN, 20), undefined, failing)
    fail = false
    // The row is durable ahead of the point and the point ahead of the head.
    assert.equal(windowKeys(map).length, failing === "windows" ? 0 : 1, failing)
    assert.equal(pointKeys(map).length, failing === "series" ? 2 : 1, failing)

    // A restart retries the same observation, then carries on.
    const restarted = new QuotaHistory(storage, () => t0 + 30 * MIN)
    await rec(restarted, t0 + 10 * MIN, 20)
    await rec(restarted, t0 + 15 * MIN, 25)
    await rec(restarted, t0 + 15 * MIN, 25)
    assert.equal(windowKeys(map).length, 1, failing)
    const page = await windows(restarted)
    assert.equal(page.windows?.length, 1, failing)
    assert.equal(page.windows?.[0].lastObservedAt, t0, failing)
    assert.equal(page.windows?.[0].nextObservedAt, t0 + 10 * MIN, failing)
    assert.equal(page.windows?.[0].apiValue?.observedUSD, usdAt(t0), "frozen at the previous point, not the new one")
    assert.equal(pointKeys(map).length, 3, failing)
  }
})

test("the window number is the latest valid pre-boundary projection, not the first max or observed subtotal", async () => {
  for (const crash of [false, true]) {
    let fail = false
    const { storage, map } = fakeStorage({ failSet: (key) => fail && key.startsWith("routing/quota-history-v1/series/") })
    const hit = t0 + MIN
    const lastEstimateAt = t0 + 2 * MIN
    const finalAt = t0 + 3 * MIN
    const projections: Record<number, QuotaApiValue> = {
      [t0]: apiAt(t0, 3), [hit]: apiAt(hit, 5),
      [lastEstimateAt]: apiAt(lastEstimateAt, 8), [finalAt]: unavailableAt(finalAt),
      [t0 + 4 * MIN]: apiAt(t0 + 4 * MIN, 999), // must not select a post-reset estimate
    }
    const { record: rec, windows } = windowHarness(storage, { [hit]: [{ ...maxedAt(hit), value: projections[hit] }] }, projections)
    let history = new QuotaHistory(storage, () => t0 + 5 * MIN)
    await rec(history, t0, 80)
    await rec(history, hit, 100)
    fail = crash
    if (crash) await assert.rejects(rec(history, lastEstimateAt, 100))
    else await rec(history, lastEstimateAt, 100)
    fail = false
    history = new QuotaHistory(storage, () => t0 + 5 * MIN)
    await rec(history, finalAt, 100)
    assert.deepEqual((map.get(seriesKeyFor("go", "weekly")) as { latestEstimate: unknown }).latestEstimate,
      projections[lastEstimateAt], "survives head repair and an unavailable final point")
    await rec(history, t0 + 4 * MIN, 2)
    const row = (await windows(history)).windows![0]
    assert.equal(row.apiValue?.projectionStatus, "unavailable", "compatibility metadata remains the final point")
    assert.deepEqual(row.finalEstimate, projections[lastEstimateAt])
    assert.equal(row.finalEstimate?.projectedFullUSD, 80)
    assert.equal(row.finalEstimate?.observedAt, lastEstimateAt)
    assert.notEqual(row.finalEstimate?.projectedFullUSD, projections[hit].projectedFullUSD, "not the estimate at the limit")
    const frozen = structuredClone(map.get(windowKeyFor("go", "weekly", finalAt)))
    projections[lastEstimateAt] = apiAt(lastEstimateAt, 99)
    await rec(history, t0 + 4 * MIN, 2)
    await history.compact(t0 + 100 * DAY)
    assert.deepEqual(map.get(windowKeyFor("go", "weekly", finalAt)), frozen, "no repricing or folding mutation")
  }
})

test("a cycle with no valid projection stays unavailable and cannot borrow the prior cycle's estimate", async () => {
  const { storage, map } = fakeStorage()
  const { record: rec, windows } = windowHarness(storage, {}, {
    [t0]: apiAt(t0, 10),
    [t0 + MIN]: unavailableAt(t0 + MIN), [t0 + 2 * MIN]: unavailableAt(t0 + 2 * MIN),
  })
  const history = new QuotaHistory(storage, () => t0 + 3 * MIN)
  await rec(history, t0, 50)
  await rec(history, t0 + MIN, 10)
  await rec(history, t0 + 2 * MIN, 20)
  assert.equal("latestEstimate" in (map.get(seriesKeyFor("go", "weekly")) as object), false)
  await rec(history, t0 + 3 * MIN, 2)
  const rows = (await windows(history)).windows!
  assert.equal(rows[0].finalEstimate?.projectedFullUSD, 100)
  assert.equal("finalEstimate" in rows[1], false, "unavailable, never zero or previous-cycle projection")
})

test("a real tracker closes its segment at a durable boundary when the reset point failed and the percentage rebounds", async () => {
  let fail = false
  const { storage, map } = fakeStorage({ failSet: (key) => fail && key.startsWith("routing/quota-history-v1/points/") })
  const config = parseConfig({ usageSources: { openai: "codex" }, tokenRates: [{
    providerID: "openai", modelID: "m", inputPerMillion: 10, outputPerMillion: 20,
    currency: "USD", source: "test", asOf: 1,
  }] })
  const tracker = new QuotaValueTracker(config)
  const estimates = new QuotaEstimates()
  const history = new QuotaHistory(storage, () => t0 + 20 * MIN)
  const observe = async (at: number, percent: number) => {
    const usage = usageAt(at, percent, { sourceID: "codex" })
    estimates.observe(usage, at)
    return history.record(usage, estimates, at, undefined, await tracker.prepare(usage, at, new Map()))
  }
  const token = (id: string, at: number, input: number) => tracker.addTokenRecord({
    hostContractVersion: "2.0.18", hostEventID: id, sourceEvent: "session.step.ended",
    hostSessionID: "s", hostMessageID: id, hostProjectID: "p", parentSessionID: null,
    hostAgentID: null, providerID: "openai", modelID: "m", variant: null,
    completedAt: at, counts: { input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    usageStatus: "reported", partial: false,
  } as never)
  await observe(t0, 20)
  token("old", t0 + 5 * MIN, 1_000_000)
  await observe(t0 + 10 * MIN, 40)
  await observe(t0 + 16 * MIN, 50)
  const last = tracker.latestValue("codex", "weekly")!
  assert.equal(last.projectionStatus, "estimated")
  fail = true
  await assert.rejects(observe(t0 + 17 * MIN, 2))
  const key = windowKeyFor("codex", "weekly", t0 + 16 * MIN)
  const frozen = structuredClone(map.get(key))
  fail = false
  // 50% -> failed 2% -> 60% inside the 15-minute gap: the 60% read is the first
  // durable point of the new cycle. The tracker must not carry the old segment.
  token("new", t0 + 18 * MIN, 2_000_000)
  await observe(t0 + 19 * MIN, 60)
  const current = tracker.latestValue("codex", "weekly")!
  assert.equal(current.trackingSince, t0 + 19 * MIN)
  assert.equal(current.observedUSD, null, "the interval before the boundary belongs to neither segment")
  assert.deepEqual(map.get(key), frozen)
  const points = await history.query({ sourceID: "codex", windowName: "weekly" }) as QuotaHistoryResult
  const first = points.points[points.points.length - 1]
  assert.equal(first.observedAt, t0 + 19 * MIN)
  assert.equal(first.cycleBoundary, true)
  const resets = (first.apiValueSnapshots ?? []).filter((snapshot) => snapshot.event === "reset")
  assert.equal(resets.length, 1, "exactly one reset snapshot")
  assert.deepEqual(resets[0].value, last)
  const head = map.get(seriesKeyFor("codex", "weekly")) as Record<string, unknown>
  assert.equal("latestEstimate" in head, false, "no estimate carried over from the old cycle")
  const page = await history.query({ kind: "windows", sourceID: "codex", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(page.windows?.length, 1)
  assert.equal(page.windows?.[0].nextObservedAt, t0 + 17 * MIN)
  assert.deepEqual(page.windows?.[0].finalEstimate, last)
  assert.equal(windowKeys(map).length, 1)
})

test("a same-clock legacy seed checkpoints its frozen point value on the existing head", async () => {
  for (const boundary of [false, true]) {
    const { storage, map } = fakeStorage()
    seedSeries(map, "go", "weekly", [t0])
    const headBefore = structuredClone(map.get(seriesKeyFor("go", "weekly")))
    const next = t0 + MIN
    const { record: rec, windows } = windowHarness(storage, {}, { [next]: unavailableAt(next) })
    const history = new QuotaHistory(storage, () => t0 + 5 * MIN)
    // The stored point predates values: persist its value and checkpoint together.
    assert.equal(await rec(history, t0, 50), false)
    assert.deepEqual(map.get(seriesKeyFor("go", "weekly")), { ...(headBefore as object), instanceAnchorAt: t0,
      currentValue: apiAt(t0, usdAt(t0)), latestEstimate: apiAt(t0, usdAt(t0)) })
    assert.deepEqual((map.get(pointKeyFor("go", "weekly", t0)) as { apiValue: unknown }).apiValue, apiAt(t0, usdAt(t0)))

    // A newer clock is an ordinary advance. Its own value is unavailable, so the
    // last valid estimate is the one the seed gave the previous durable point.
    assert.equal(await rec(history, next, boundary ? 10 : 60), true)
    if (boundary) {
      assert.deepEqual((await windows(history)).windows![0].finalEstimate, apiAt(t0, usdAt(t0)))
    } else {
      assert.deepEqual((map.get(seriesKeyFor("go", "weekly")) as { latestEstimate: unknown }).latestEstimate, apiAt(t0, usdAt(t0)))
    }
  }
})

test("a boundary point that failed with no value plan is valued on retry and does not wedge", async () => {
  let fail = false
  const { storage, map } = fakeStorage({ failSet: (key) => fail && key.startsWith("routing/quota-history-v1/points/") })
  const { record: rec, windows } = windowHarness(storage)
  const history = new QuotaHistory(storage, () => t0 + 5 * MIN)
  await rec(history, t0, 50)
  // The failed attempt has no plan at all (usage for the tracker was unavailable).
  const bare = new QuotaEstimates()
  const failed = usageAt(t0 + MIN, 10)
  bare.observe(failed, t0 + MIN)
  fail = true
  await assert.rejects(history.record(failed, bare, t0 + MIN))
  fail = false
  assert.equal(windowKeys(map).length, 1)
  assert.equal(await rec(history, t0 + 2 * MIN, 12), true, "the retry is not blocked by missing recovery evidence")
  const points = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
  assert.equal(points.points[1].cycleBoundary, true)
  assert.deepEqual(points.points[1].apiValue, apiAt(t0 + 2 * MIN, usdAt(t0 + 2 * MIN)))
  assert.equal((await windows(history)).windows?.length, 1)
})

test("a damaged row at the closure key is neither rewritten nor wedges the series", async () => {
  for (const percent of [60, 10]) {
    const { storage, map } = fakeStorage()
    seedSeries(map, "go", "weekly", [t0])
    const damaged = { version: 1, sourceID: "go", windowName: "weekly", lastObservedAt: t0, nextPercent: "bad" }
    map.set(windowKeyFor("go", "weekly", t0), structuredClone(damaged))
    const { record: rec, windows } = windowHarness(storage)
    const history = new QuotaHistory(storage, () => t0 + 5 * MIN)
    assert.equal(await rec(history, t0 + MIN, percent), true, `percent ${percent}`)
    assert.equal(await rec(history, t0 + 2 * MIN, percent + 1), true, `percent ${percent}`)
    assert.deepEqual(map.get(windowKeyFor("go", "weekly", t0)), damaged, "touched nothing")
    assert.deepEqual((await windows(history)).windows, [], "a damaged row is skipped by reads")
    const points = await history.query({ sourceID: "go", windowName: "weekly" }) as QuotaHistoryResult
    assert.deepEqual(points.points.map((point) => point.cycleBoundary), [false, true, false])
  }
  // A failed read of the key is not "no closure": it aborts rather than guessing.
  const { storage, map } = fakeStorage({ failGet: (key) => key === windowKeyFor("go", "weekly", t0) })
  seedSeries(map, "go", "weekly", [t0])
  const { record: rec } = windowHarness(storage)
  await assert.rejects(rec(new QuotaHistory(storage, () => t0), t0 + MIN, 10))
  assert.equal(pointKeys(map).length, 1)
})

test("the first durable point of a new cycle starts its own estimate, not the closed window's", async () => {
  let fail = false
  const { storage, map } = fakeStorage({ failSet: (key) => fail && key.startsWith("routing/quota-history-v1/points/") })
  const boundary = t0 + MIN
  const rebound = t0 + 2 * MIN
  const { record: rec, windows } = windowHarness(storage, {}, { [rebound]: unavailableAt(rebound) })
  const history = new QuotaHistory(storage, () => t0 + 4 * MIN)
  await rec(history, t0, 80, { resetsAt: boundary })
  fail = true
  await assert.rejects(rec(history, boundary, 100))
  fail = false
  await rec(history, rebound, 100)
  assert.equal("latestEstimate" in (map.get(seriesKeyFor("go", "weekly")) as object), false)
  await rec(history, t0 + 3 * MIN, 2)
  const rows = (await windows(history)).windows!
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0].finalEstimate, apiAt(t0, usdAt(t0)))
  assert.equal("finalEstimate" in rows[1], false, "the failed point's estimate is not history, and the old one is not borrowed")
})
