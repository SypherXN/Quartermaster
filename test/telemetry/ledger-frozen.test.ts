import assert from "node:assert/strict"
import test from "node:test"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { TokenLedger } from "../../src/telemetry/ledger.ts"
import { buildQuartermasterReport } from "../../src/telemetry/report.ts"
import type { CatalogPrice } from "../../src/telemetry/prices.ts"
import type { TokenTelemetryRecord } from "../../src/telemetry/types.ts"

const DAY = 86_400_000
const priceA: CatalogPrice[] = [{ tierSize: null, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.4, cacheReadKnown: true, cacheWriteKnown: true }]
const priceB: CatalogPrice[] = [{ tierSize: null, input: 10, output: 20, cacheRead: 1, cacheWrite: 2, cacheReadKnown: true, cacheWriteKnown: true }]

class MemoryStorage {
  values = new Map<string, unknown>()
  failSet?: (key: string, value: unknown, call: number) => boolean
  failSetAfter?: (key: string, value: unknown, call: number) => boolean
  failRemove?: (key: string, call: number) => boolean
  failRemoveAfter?: (key: string, call: number) => boolean
  setCalls = 0
  removeCalls = 0
  async get(key: string) { return this.values.get(key) }
  async set(key: string, value: unknown) {
    this.setCalls += 1
    if (this.failSet?.(key, value, this.setCalls)) throw new Error("set failed")
    this.values.set(key, value)
    if (this.failSetAfter?.(key, value, this.setCalls)) throw new Error("set ack lost")
  }
  async remove(key: string) {
    this.removeCalls += 1
    if (this.failRemove?.(key, this.removeCalls)) throw new Error("remove failed")
    this.values.delete(key)
    if (this.failRemoveAfter?.(key, this.removeCalls)) throw new Error("remove ack lost")
  }
  async scan(options: { prefix: string; after?: string; limit?: number }) {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(options.prefix) && (!options.after || key > options.after)).sort()
    const page = keys.slice(0, options.limit ?? 1_000)
    return {
      entries: page.map((key) => ({ key, value: this.values.get(key) as never })),
      ...(keys.length > page.length ? { next: page.at(-1)! } : {}),
    }
  }
}

function record(id: string, at: number, input = 1_000_000, output = 0): TokenTelemetryRecord {
  return {
    hostContractVersion: "2.0.18", hostEventID: id, sourceEvent: "session.step.ended",
    hostSessionID: `session-${id}`, hostMessageID: `message-${id}`, hostProjectID: "project-a",
    parentSessionID: null, hostAgentID: null, providerID: "openai", modelID: "gpt-6-luna", variant: null,
    completedAt: at, counts: { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    usageStatus: "reported", partial: false,
  }
}

test("freezes the first API price across a family upgrade, duplicates and restart", async () => {
  const storage = new MemoryStorage()
  let current = priceA
  const options = { now: () => 100, apiPrice: async () => current }
  const ledger = new TokenLedger(storage as unknown as StorageDomain, options)
  await ledger.ingest(record("a", 10, 1_000_000, 0))
  current = priceB
  await ledger.ingest(record("b", 11, 1_000_000, 0))
  // Revised counts keep the first frozen table.
  await ledger.ingest(record("a", 10, 2_000_000, 0))
  let snap = await ledger.snapshot()
  assert.equal(snap.records.find((row) => row.hostEventID === "a")?.apiPrice?.prices[0].input, 2)
  assert.equal(snap.records.find((row) => row.hostEventID === "b")?.apiPrice?.prices[0].input, 10)

  const restarted = new TokenLedger(storage as unknown as StorageDomain, { now: () => 200, apiPrice: async () => priceB })
  await restarted.ingest(record("a", 10, 3_000_000, 0))
  snap = await restarted.snapshot()
  assert.equal(snap.records.find((row) => row.hostEventID === "a")?.apiPrice?.prices[0].input, 2)
  assert.equal(snap.records.find((row) => row.hostEventID === "a")?.counts?.input, 3_000_000)

  const unavailable = new TokenLedger(storage as unknown as StorageDomain, {
    now: () => 300, apiPrice: async () => { throw new Error("down") },
  })
  await unavailable.ingest(record("c", 12))
  const explicit = new TokenLedger(storage as unknown as StorageDomain, { now: () => 400, apiPrice: async () => [] })
  await explicit.ingest(record("d", 13))
  await new TokenLedger(storage as unknown as StorageDomain, { now: () => 500 }).ingest(record("legacy", 14))
  snap = await explicit.snapshot()
  assert.equal(snap.records.find((row) => row.hostEventID === "c")?.apiPrice?.source, "unavailable")
  assert.deepEqual(snap.records.find((row) => row.hostEventID === "d")?.apiPrice?.prices, [])
  assert.equal(snap.records.find((row) => row.hostEventID === "legacy")?.apiPrice, undefined)
})

test("folds frozen costs into lifetime once, tombstones replay, and report uses the archived total", async () => {
  const storage = new MemoryStorage()
  let clock = 0
  const ledger = new TokenLedger(storage as unknown as StorageDomain, {
    now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
  })
  await ledger.ingest(record("a", 10))
  await ledger.ingest(record("b", 20))
  clock = DAY + 1
  let snap = await ledger.snapshot()
  assert.equal(snap.records.length, 0)
  assert.equal(snap.lifetime.length, 2)
  const before = snap.lifetime.reduce((sum, row) => sum + (row.apiCost?.total ?? 0), 0)
  assert.equal(before, 4)

  await ledger.ingest(record("a", 10, 2_000_000, 0))
  snap = await ledger.snapshot()
  assert.equal(snap.records.length, 0)
  assert.equal(snap.lifetime.reduce((sum, row) => sum + (row.apiCost?.total ?? 0), 0), 4)

  const report = await buildQuartermasterReport({
    projectID: "project-a",
    tokenLedger: ledger,
    errorLedger: { list: async () => [] },
    attributionLedger: { list: async () => [] },
    budgets: undefined,
    tokenRates: undefined,
  }, { limit: 100, offset: 0 }, false)
  assert.equal(report.apiEquivalent?.pricing, "recorded-api-price")
  assert.equal(report.apiEquivalent?.scope, "selected-range-with-older-cumulative")
  assert.equal(report.apiEquivalent?.retainedUSD, null)
  assert.equal(report.apiEquivalent?.archivedUSD, 4)
  assert.equal(report.apiEquivalent?.archivedRecords, 2)
  assert.equal(report.apiEquivalent?.legacyUnknownRecords, 0)
  const model = report.dimensions.items.find((item) => item.value === "openai/gpt-6-luna")
  assert.equal(model?.apiCosts?.total, 4)
  assert.equal(model?.apiCosts?.pricedRecords, 2)

  const ranged = await buildQuartermasterReport({
    projectID: "project-a",
    tokenLedger: ledger,
    errorLedger: { list: async () => [] },
    attributionLedger: { list: async () => [] },
    budgets: undefined,
    tokenRates: undefined,
  }, { since: 0, limit: 100, offset: 0 }, false)
  assert.equal(ranged.apiEquivalent, undefined)
})

test("a failed journal apply resumes idempotently without losing or double counting", async () => {
  const storage = new MemoryStorage()
  let clock = 0
  const ledger = new TokenLedger(storage as unknown as StorageDomain, {
    now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
  })
  await ledger.ingest(record("a", 10))
  await ledger.ingest(record("b", 20))
  clock = DAY + 1
  storage.failSet = (key) => key.startsWith("quartermaster:telemetry:lifetime:v1:")
  await assert.rejects(ledger.snapshot())
  assert.equal([...storage.values.keys()].filter((key) => key.startsWith("quartermaster:telemetry:v1:")).length, 2)
  storage.failSet = undefined
  const resumed = new TokenLedger(storage as unknown as StorageDomain, {
    now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
  })
  let snap = await resumed.snapshot()
  assert.equal(snap.records.length, 0)
  assert.equal(snap.lifetime.reduce((sum, row) => sum + (row.apiCost?.total ?? 0), 0), 4)

  storage.failRemove = (key) => key.startsWith("quartermaster:telemetry:v1:")
  clock += DAY
  await assert.rejects(resumed.ingest(record("c", 30)))
  storage.failRemove = undefined
  snap = await resumed.snapshot()
  assert.equal(snap.records.length, 0)
  assert.equal(snap.lifetime.reduce((sum, row) => sum + (row.apiCost?.total ?? 0), 0), 6)
})

test("a malformed journal or lifetime row aborts without deleting raw money", async () => {
  const storage = new MemoryStorage()
  let clock = DAY + 1
  const ledger = new TokenLedger(storage as unknown as StorageDomain, {
    now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
  })
  clock = 0
  await ledger.ingest(record("a", 10))
  clock = DAY + 1
  storage.values.set("quartermaster:telemetry:fold-journal:v1", "not-a-journal")
  await assert.rejects(ledger.snapshot())
  assert.equal([...storage.values.keys()].filter((key) => key.startsWith("quartermaster:telemetry:v1:")).length, 1)
  storage.values.delete("quartermaster:telemetry:fold-journal:v1")

  storage.values.set(`quartermaster:telemetry:lifetime:v1:${encodeURIComponent(JSON.stringify(["project-a", null, "openai", "gpt-6-luna", null, "session-a", null]))}`, { version: 1 })
  await assert.rejects(ledger.snapshot())
  assert.equal([...storage.values.keys()].filter((key) => key.startsWith("quartermaster:telemetry:v1:")).length, 1)
  for (const key of [...storage.values.keys()]) if (key.startsWith("quartermaster:telemetry:lifetime:v1:")) storage.values.delete(key)
  const snap = await ledger.snapshot()
  assert.equal(snap.records.length, 0)
  assert.equal(snap.lifetime.reduce((sum, row) => sum + (row.apiCost?.total ?? 0), 0), 2)
})

test("folds more than one batch", async () => {
  const storage = new MemoryStorage()
  let clock = 0
  const ledger = new TokenLedger(storage as unknown as StorageDomain, {
    now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
  })
  for (let index = 0; index < 1_001; index++) await ledger.ingest(record(`e-${index}`, 10 + index))
  clock = DAY + 1
  const snap = await ledger.snapshot()
  assert.equal(snap.records.length, 0)
  assert.equal(snap.lifetime.reduce((sum, row) => sum + (row.apiCost?.pricedRecords ?? 0), 0), 1_001)
  assert.equal(snap.lifetime.reduce((sum, row) => sum + (row.apiCost?.total ?? 0), 0), 2_002)
})

test("keeps the exact retention boundary raw", async () => {
  const storage = new MemoryStorage()
  let clock = 0
  const ledger = new TokenLedger(storage as unknown as StorageDomain, {
    now: () => clock, retentionMs: DAY + 1 - 50, apiPrice: async () => priceA,
  })
  await ledger.ingest(record("before", 49))
  await ledger.ingest(record("boundary", 50))
  clock = DAY + 1
  const snap = await ledger.snapshot()
  assert.deepEqual(snap.records.map((row) => row.hostEventID), ["boundary"])
  assert.equal(snap.lifetime.reduce((sum, row) => sum + (row.apiCost?.pricedRecords ?? 0), 0), 1)
})

test("counts pre-feature lifetime records as historical-unknown when folding resumes", async () => {
  const storage = new MemoryStorage()
  const key = `quartermaster:telemetry:lifetime:v1:${encodeURIComponent(JSON.stringify([
    "project-a", null, "openai", "gpt-6-luna", null, "legacy-session", null,
  ]))}`
  storage.values.set(key, {
    projectID: "project-a", hostSessionID: "legacy-session", parentSessionID: null,
    agentID: null, providerID: "openai", modelID: "gpt-6-luna", variant: null,
    records: 2, observedTokens: 200, unknownTokenRecords: 0, partialRecords: 0,
    input: 100, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    unknownCacheRecords: 0, hostCostUSD: 0, hostCostMissing: 0,
  })
  let clock = 0
  const ledger = new TokenLedger(storage as unknown as StorageDomain, {
    now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
  })
  const fresh = record("new", 10)
  fresh.hostSessionID = "legacy-session"
  await ledger.ingest(fresh)
  clock = DAY + 1
  const snap = await ledger.snapshot()
  assert.equal(snap.lifetime.length, 1)
  assert.equal(snap.lifetime[0].records, 3)
  assert.equal(snap.lifetime[0].apiRecords, 1)
  assert.equal(snap.lifetime[0].apiUnknownRecords, 2)
  assert.equal(snap.lifetime[0].apiCost?.pricedRecords, 1)
})

test("journal failures before and after apply recover on the same or a restarted instance", async () => {
  const JOURNAL = "quartermaster:telemetry:fold-journal:v1"
  const LIFETIME = "quartermaster:telemetry:lifetime:v1:"
  const TOMBSTONE = "quartermaster:telemetry:tombstone:v1:"
  const RAW = "quartermaster:telemetry:v1:"
  const failures = [
    { op: "set", name: "journal", match: (key: string) => key === JOURNAL, nth: 1 },
    { op: "set", name: "target-1", match: (key: string) => key.startsWith(LIFETIME), nth: 1 },
    { op: "set", name: "target-2", match: (key: string) => key.startsWith(LIFETIME), nth: 2 },
    { op: "set", name: "tombstone-1", match: (key: string) => key.startsWith(TOMBSTONE), nth: 1 },
    { op: "set", name: "tombstone-2", match: (key: string) => key.startsWith(TOMBSTONE), nth: 2 },
    { op: "remove", name: "raw-1", match: (key: string) => key.startsWith(RAW), nth: 1 },
    { op: "remove", name: "raw-2", match: (key: string) => key.startsWith(RAW), nth: 2 },
    { op: "remove", name: "journal-clear", match: (key: string) => key === JOURNAL, nth: 1 },
  ] as const
  for (const after of [false, true]) {
    for (const recovery of ["same", "restart"] as const) {
      for (const failure of failures) {
        const storage = new MemoryStorage()
        let clock = 0
        const ledger = new TokenLedger(storage as unknown as StorageDomain, {
          now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
        })
        await ledger.ingest(record("a", 10))
        await ledger.ingest(record("b", 20))
        clock = DAY + 1
        let calls = 0
        const predicate = (key: string) => {
          if (!failure.match(key)) return false
          calls += 1
          return calls === failure.nth
        }
        if (failure.op === "set") {
          if (after) storage.failSetAfter = predicate
          else storage.failSet = predicate
        } else if (after) storage.failRemoveAfter = predicate
        else storage.failRemove = predicate
        const label = `${failure.name} ${after ? "after" : "before"} ${recovery}`
        await assert.rejects(ledger.snapshot(), label)
        storage.failSet = undefined
        storage.failSetAfter = undefined
        storage.failRemove = undefined
        storage.failRemoveAfter = undefined
        const target = recovery === "same" ? ledger : new TokenLedger(storage as unknown as StorageDomain, {
          now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
        })
        let snap = await target.snapshot()
        assert.equal(snap.records.length, 0, label)
        assert.equal(snap.lifetime.reduce((sum, row) => sum + (row.apiCost?.total ?? 0), 0), 4, label)
        assert.equal(snap.lifetime.reduce((sum, row) => sum + (row.apiRecords ?? 0), 0), 2, label)
        assert.equal(snap.lifetime.reduce((sum, row) => sum + (row.apiUnknownRecords ?? 0), 0), 0, label)
        assert.equal(snap.lifetime.reduce((sum, row) => sum + (row.apiCost?.pricedRecords ?? 0), 0), 2, label)
        assert.equal([...storage.values.keys()].filter((key) => key.startsWith(TOMBSTONE)).length, 2, label)
        await target.ingest(record("a", 10))
        snap = await target.snapshot()
        assert.equal(snap.records.length, 0, label)
        assert.equal(snap.lifetime.reduce((sum, row) => sum + (row.apiCost?.total ?? 0), 0), 4, label)
      }
    }
  }
})

test("a malformed optional api price blocks pruning without deleting the token row", async () => {
  const storage = new MemoryStorage()
  let clock = DAY + 1
  const ledger = new TokenLedger(storage as unknown as StorageDomain, { now: () => clock, retentionMs: 50 })
  clock = 0
  const raw = record("bad-price", 10)
  storage.values.set(`quartermaster:telemetry:v1:${encodeURIComponent(raw.hostEventID)}`, {
    ...raw, apiPrice: { recordedAt: 10, source: "catalog", prices: "not-rows" },
  })
  clock = DAY + 1
  await assert.rejects(ledger.snapshot())
  assert.equal(storage.values.has(`quartermaster:telemetry:v1:${encodeURIComponent(raw.hostEventID)}`), true)
})

test("numeric overflow aborts folding before any raw delete", async () => {
  const storage = new MemoryStorage()
  const max = Number.MAX_SAFE_INTEGER
  const key = `quartermaster:telemetry:lifetime:v1:${encodeURIComponent(JSON.stringify([
    "project-a", null, "openai", "gpt-6-luna", null, "shared-session", null,
  ]))}`
  storage.values.set(key, {
    projectID: "project-a", hostSessionID: "shared-session", parentSessionID: null,
    agentID: null, providerID: "openai", modelID: "gpt-6-luna", variant: null,
    records: max, observedTokens: 0, unknownTokenRecords: 0, partialRecords: 0,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    unknownCacheRecords: 0, hostCostUSD: 0, hostCostMissing: 0,
    apiRecords: max, apiUnknownRecords: 0,
    apiCost: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0,
      pricedRecords: max, unpricedRecords: 0, partialRecords: 0, cacheUnpricedRecords: 0,
      pricedTokens: 0, unpricedTokens: 0, unknownTokenRecords: 0,
    },
  })
  let clock = 0
  const ledger = new TokenLedger(storage as unknown as StorageDomain, {
    now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
  })
  const raw = record("overflow", 10)
  raw.hostSessionID = "shared-session"
  await ledger.ingest(raw)
  clock = DAY + 1
  await assert.rejects(ledger.snapshot())
  assert.equal(storage.values.has(`quartermaster:telemetry:v1:${encodeURIComponent("overflow")}`), true)
})

test("duplicate legacy rows keep an absent snapshot even when the replay supplies one", async () => {
  const storage = new MemoryStorage()
  const ledger = new TokenLedger(storage as unknown as StorageDomain, { now: () => 100 })
  await ledger.ingest(record("legacy", 10))
  await ledger.ingest({
    ...record("legacy", 10),
    apiPrice: { recordedAt: 50, source: "catalog", prices: priceA },
  })
  const snap = await ledger.snapshot()
  assert.equal(snap.records[0].apiPrice, undefined)
})

test("list limit still returns the most recent rows", async () => {
  const storage = new MemoryStorage()
  const ledger = new TokenLedger(storage as unknown as StorageDomain, { now: () => 100 })
  await ledger.ingest(record("a", 10))
  await ledger.ingest(record("b", 20))
  await ledger.ingest(record("c", 30))
  const rows = await ledger.list({ limit: 2 })
  assert.deepEqual(rows.map((row) => row.hostEventID), ["b", "c"])
})

test("rejects malformed lifetime coverage metadata without deleting its raw record", async () => {
  const base = {
    projectID: "project-a", hostSessionID: "session-a", parentSessionID: null,
    agentID: null, providerID: "openai", modelID: "gpt-6-luna", variant: null,
    records: 1, observedTokens: 1_000, unknownTokenRecords: 0, partialRecords: 0,
    input: 500, output: 500, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    unknownCacheRecords: 0, hostCostUSD: 0, hostCostMissing: 0,
  }
  const cost = (overrides: Record<string, unknown>) => ({
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0,
    pricedRecords: 1, unpricedRecords: 0, partialRecords: 0, cacheUnpricedRecords: 0,
    pricedTokens: 1_000, unpricedTokens: 0, unknownTokenRecords: 0, ...overrides,
  })
  const variants = [
    { apiRecords: 1, apiUnknownRecords: 0 },
    { apiUnknownRecords: 1 },
    { apiRecords: 1, apiUnknownRecords: 0, apiCost: cost({ pricedRecords: 0 }) },
    { apiRecords: 1, apiUnknownRecords: 0, apiCost: cost({ unknownTokenRecords: 2 }) },
  ]
  for (const variant of variants) {
    const storage = new MemoryStorage()
    let clock = 0
    const ledger = new TokenLedger(storage as unknown as StorageDomain, {
      now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
    })
    await ledger.ingest(record("a", 10))
    const key = `quartermaster:telemetry:lifetime:v1:${encodeURIComponent(JSON.stringify([
      "project-a", null, "openai", "gpt-6-luna", null, "session-a", null,
    ]))}`
    storage.values.set(key, { ...base, ...variant })
    clock = DAY + 1
    await assert.rejects(ledger.snapshot(), JSON.stringify(variant))
    assert.equal(storage.values.has(`quartermaster:telemetry:v1:${encodeURIComponent("a")}`), true)
  }
})
test("rejects an unsafe journal key pair, and concurrent snapshots fold once", async () => {
  const storage = new MemoryStorage()
  let clock = 0
  const ledger = new TokenLedger(storage as unknown as StorageDomain, {
    now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
  })
  await ledger.ingest(record("safe", 10))
  clock = DAY + 1
  const targetRow = {
    projectID: "project-a", hostSessionID: "session-project-a", parentSessionID: null,
    agentID: null, providerID: "openai", modelID: "gpt-6-luna", variant: null,
    records: 1, observedTokens: 1_000, unknownTokenRecords: 0, partialRecords: 0,
    input: 500, output: 500, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    unknownCacheRecords: 0, hostCostUSD: 0, hostCostMissing: 0,
  }
  const targetKey = `quartermaster:telemetry:lifetime:v1:${encodeURIComponent(JSON.stringify([
    "project-a", null, "openai", "gpt-6-luna", null, "session-project-a", null,
  ]))}`
  storage.values.set("quartermaster:telemetry:v1:not-an-id", {})
  storage.values.set("quartermaster:telemetry:v1:foreign", {})
  storage.values.set("quartermaster:telemetry:fold-journal:v1", {
    version: 1, targets: [{ key: targetKey, row: targetRow }],
    rawKeys: ["quartermaster:telemetry:v1:not-an-id"], tombstones: ["safe"],
  })
  await assert.rejects(ledger.snapshot())
  assert.equal(storage.values.has("quartermaster:telemetry:v1:not-an-id"), true)
  assert.equal(storage.values.has("quartermaster:telemetry:v1:foreign"), true)
  assert.equal(storage.values.has(`quartermaster:telemetry:v1:${encodeURIComponent("safe")}`), true)
  storage.values.delete("quartermaster:telemetry:fold-journal:v1")

  const [first, second] = await Promise.all([ledger.snapshot(), ledger.snapshot()])
  assert.equal(first.lifetime.reduce((sum, row) => sum + (row.apiCost?.total ?? 0), 0), 2)
  assert.equal(second.lifetime.reduce((sum, row) => sum + (row.apiCost?.total ?? 0), 0), 2)
  assert.equal(first.records.length + second.records.length, 0)
})

test("destructive cleanup recovers a pending journal before removing rows", async () => {
  const storage = new MemoryStorage()
  let clock = 0
  const ledger = new TokenLedger(storage as unknown as StorageDomain, {
    now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
  })
  await ledger.ingest(record("a", 10))
  clock = DAY + 1
  await ledger.snapshot()
  await ledger.ingest(record("b", 20))
  // Leave a deliberately broken journal; cleanup must refuse instead of deleting.
  storage.values.set("quartermaster:telemetry:fold-journal:v1", "not-a-journal")
  await assert.rejects(ledger.removeProject("project-a"))
  assert.equal([...storage.values.keys()].filter((key) => key.startsWith("quartermaster:telemetry:v1:")).length, 1)
  storage.values.delete("quartermaster:telemetry:fold-journal:v1")
  await ledger.removeProject("project-a")
  assert.equal([...storage.values.keys()].filter((key) => key.startsWith("quartermaster:telemetry:v1:")).length, 0)
})
