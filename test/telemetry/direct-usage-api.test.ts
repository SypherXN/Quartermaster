import assert from "node:assert/strict"
import test from "node:test"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import {
  DirectUsageLedger,
  directUsageApiCost,
  directUsageFromInput,
  type DirectUsageInput,
} from "../../src/telemetry/direct-usage.ts"
import type { CatalogPrice } from "../../src/telemetry/prices.ts"

const DAY_MS = 86_400_000
const RAW = "quartermaster:direct-usage:v1:"
const LIFETIME = "quartermaster:direct-usage:lifetime:v1:"
const TOMBSTONE = "quartermaster:direct-usage:tombstone:v1:"
const JOURNAL = "quartermaster:direct-usage:fold-journal:v1"

const priceA: CatalogPrice[] = [
  { tierSize: null, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.4, cacheReadKnown: true, cacheWriteKnown: true },
]
const priceB: CatalogPrice[] = [
  { tierSize: null, input: 10, output: 20, cacheRead: 1, cacheWrite: 2, cacheReadKnown: true, cacheWriteKnown: true },
]

class MemoryStorage implements StorageDomain {
  values = new Map<string, unknown>()
  failSet?: (key: string, value: unknown, call: number) => boolean
  failSetAfter?: (key: string, value: unknown, call: number) => boolean
  failRemove?: (key: string, call: number) => boolean
  failRemoveAfter?: (key: string, call: number) => boolean
  setCalls = 0
  removeCalls = 0
  async get(key: string) { return this.values.get(key) as never }
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

function input(usageID: string, inputTokens: number, outputTokens = 0, modelID = "gpt-6-luna"): DirectUsageInput {
  return {
    projectID: "project-a", pluginID: "opr", pluginName: "OPR", usageID,
    providerID: "openai", modelID,
    counts: { input: inputTokens, output: outputTokens, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

test("freezes the first API price across price changes, revisions and restart", async () => {
  const storage = new MemoryStorage()
  const start = 2_000_000_000_000
  let current = priceA
  const ledger = new DirectUsageLedger(storage as unknown as StorageDomain, {
    now: () => start, apiPrice: async () => current,
  })
  await ledger.record(input("a", 1_000_000))
  current = priceB
  await ledger.record(input("b", 1_000_000))

  const revised = await ledger.record(input("a", 2_000_000))
  assert.equal(revised.replaced, true)
  let snap = await ledger.snapshot()
  const a = snap.records.find((row) => row.usageID === "a")
  assert.equal(a?.apiPrice?.prices[0].input, 2)
  assert.equal(a?.counts.input, 2_000_000)
  assert.equal(a?.reportedAt, start)
  assert.equal(snap.records.find((row) => row.usageID === "b")?.apiPrice?.prices[0].input, 10)

  const restarted = new DirectUsageLedger(storage as unknown as StorageDomain, {
    now: () => start + 100, apiPrice: async () => priceB,
  })
  await restarted.record(input("a", 3_000_000))
  snap = await restarted.snapshot()
  assert.equal(snap.records.find((row) => row.usageID === "a")?.apiPrice?.prices[0].input, 2)
})

test("a legacy row stays unknown forever and folds as historical-unknown", async () => {
  const storage = new MemoryStorage()
  const legacy = new DirectUsageLedger(storage as unknown as StorageDomain, { now: () => 0 })
  await legacy.record(input("legacy", 100))

  const priced = new DirectUsageLedger(storage as unknown as StorageDomain, {
    now: () => 100, apiPrice: async () => priceA,
  })
  await priced.record(input("legacy", 200))
  const records = await priced.list("project-a")
  assert.equal(records[0]?.apiPrice, undefined)
  assert.equal(records[0]?.counts.input, 200)

  const expiring = new DirectUsageLedger(storage as unknown as StorageDomain, {
    now: () => DAY_MS + 1, retentionMs: 50, apiPrice: async () => priceA,
  })
  const snap = await expiring.snapshot("project-a")
  assert.equal(snap.records.length, 0)
  assert.equal(snap.lifetime[0]?.apiRecords, 0)
  assert.equal(snap.lifetime[0]?.apiUnknownRecords, 1)
  assert.equal(snap.lifetime[0]?.apiCost, undefined)
})

test("explicit empty and zero prices are known-unpriced, a missing snapshot is unknown", async () => {
  const storage = new MemoryStorage()
  const empty = new DirectUsageLedger(storage as unknown as StorageDomain, {
    now: () => 10, apiPrice: async () => [],
  })
  await empty.record(input("empty", 1_000_000))
  const zero = new DirectUsageLedger(storage as unknown as StorageDomain, {
    now: () => 10,
    apiPrice: async () => [{ tierSize: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
  })
  await zero.record(input("zero", 1_000_000))
  const unavailable = new DirectUsageLedger(storage as unknown as StorageDomain, {
    now: () => 10, apiPrice: async () => { throw new Error("down") },
  })
  await unavailable.record(input("unavailable", 1_000_000))
  const missing = new DirectUsageLedger(storage as unknown as StorageDomain, { now: () => 10 })
  await missing.record(input("missing", 1_000_000))

  const rows = await missing.list("project-a")
  const byID = new Map(rows.map((row) => [row.usageID, row]))
  for (const usageID of ["empty", "zero", "unavailable"]) {
    const cost = directUsageApiCost(byID.get(usageID)!)
    assert.ok(cost, usageID)
    assert.equal(cost.pricedRecords, 0, usageID)
    assert.equal(cost.unpricedRecords, 1, usageID)
    assert.equal(cost.total, 0, usageID)
  }
  assert.equal(byID.get("empty")?.apiPrice?.source, "catalog")
  assert.equal(byID.get("unavailable")?.apiPrice?.source, "unavailable")
  assert.equal(directUsageApiCost(byID.get("missing")!), undefined)
})

test("folds frozen USD once and a replay after the fold writes nothing", async () => {
  const storage = new MemoryStorage()
  let clock = 0
  const ledger = new DirectUsageLedger(storage as unknown as StorageDomain, {
    now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
  })
  await ledger.record(input("a", 1_000_000))
  await ledger.record(input("b", 1_000_000))
  clock = DAY_MS + 1
  let snap = await ledger.snapshot()
  assert.equal(snap.records.length, 0)
  assert.equal(snap.lifetime.length, 1)
  assert.equal(snap.lifetime[0]?.records, 2)
  assert.equal(snap.lifetime[0]?.apiRecords, 2)
  assert.equal(snap.lifetime[0]?.apiUnknownRecords, 0)
  assert.equal(snap.lifetime[0]?.apiCost?.total, 4)
  assert.equal(snap.lifetime[0]?.apiCost?.pricedRecords, 2)

  await ledger.record(input("a", 2_000_000))
  snap = await ledger.snapshot()
  assert.equal(snap.records.length, 0)
  assert.equal(snap.lifetime[0]?.apiCost?.total, 4)
  assert.equal(snap.lifetime[0]?.records, 2)

  const restarted = new DirectUsageLedger(storage as unknown as StorageDomain, {
    now: () => clock, retentionMs: 50, apiPrice: async () => priceB,
  })
  await restarted.record(input("a", 3_000_000))
  snap = await restarted.snapshot()
  assert.equal(snap.lifetime[0]?.apiCost?.total, 4)
})

test("keeps the exact 90 day boundary raw and folds one day later", async () => {
  const storage = new MemoryStorage()
  const start = 2_100_000_000_000
  const retentionMs = 90 * DAY_MS
  let clock = start
  const first = new DirectUsageLedger(storage as unknown as StorageDomain, {
    now: () => clock, retentionMs, apiPrice: async () => priceA,
  })
  await first.record(input("boundary", 1_000_000))

  clock = start + retentionMs
  let snap = await first.snapshot()
  assert.deepEqual(snap.records.map((row) => row.usageID), ["boundary"])
  assert.equal(snap.lifetime.length, 0)

  const second = new DirectUsageLedger(storage as unknown as StorageDomain, {
    now: () => start + retentionMs + 1, retentionMs, apiPrice: async () => priceA,
  })
  snap = await second.snapshot()
  assert.equal(snap.records.length, 0)
  assert.equal(snap.lifetime.length, 1)
  assert.equal(snap.lifetime[0]?.apiRecords, 1)
  assert.equal(snap.lifetime[0]?.apiCost?.total, 2)

  await second.record(input("boundary", 2_000_000))
  snap = await second.snapshot()
  assert.equal(snap.lifetime[0]?.records, 1)
  assert.equal(snap.lifetime[0]?.apiCost?.total, 2)
})

test("recovers an interrupted fold from the journal without double counting", async () => {
  const storage = new MemoryStorage()
  let clock = 0
  const ledger = new DirectUsageLedger(storage as unknown as StorageDomain, {
    now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
  })
  await ledger.record(input("a", 1_000_000))
  await ledger.record(input("b", 1_000_000))
  clock = DAY_MS + 1
  storage.failSet = (key) => key.startsWith(LIFETIME)
  await assert.rejects(ledger.snapshot())
  assert.equal([...storage.values.keys()].filter((key) => key.startsWith(RAW)).length, 2)

  storage.failSet = undefined
  const resumed = new DirectUsageLedger(storage as unknown as StorageDomain, {
    now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
  })
  const snap = await resumed.snapshot()
  assert.equal(snap.records.length, 0)
  assert.equal(snap.lifetime[0]?.records, 2)
  assert.equal(snap.lifetime[0]?.apiCost?.total, 4)
  assert.equal([...storage.values.keys()].filter((key) => key.startsWith(RAW)).length, 0)
})

test("every journal application failure point recovers without losing or double counting money", async () => {
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
  const assertMixed = (
    snap: {
      records: unknown[]
      lifetime: Array<{
        records: number
        apiRecords?: number
        apiUnknownRecords?: number
        apiCost?: { total: number; pricedRecords: number }
      }>
    },
    storage: MemoryStorage,
    label: string,
  ) => {
    assert.equal(snap.records.length, 0, label)
    assert.equal(snap.lifetime.length, 2, label)
    assert.equal(snap.lifetime.reduce((sum, row) => sum + row.records, 0), 2, label)
    assert.equal(snap.lifetime.reduce((sum, row) => sum + (row.apiRecords ?? 0), 0), 1, label)
    assert.equal(snap.lifetime.reduce((sum, row) => sum + (row.apiUnknownRecords ?? 0), 0), 1, label)
    assert.equal(snap.lifetime.reduce((sum, row) => sum + (row.apiCost?.total ?? 0), 0), 2, label)
    assert.equal(snap.lifetime.reduce((sum, row) => sum + (row.apiCost?.pricedRecords ?? 0), 0), 1, label)
    assert.equal([...storage.values.keys()].filter((key) => key.startsWith(RAW)).length, 0, label)
    assert.equal([...storage.values.keys()].filter((key) => key.startsWith(TOMBSTONE)).length, 2, label)
  }

  for (const after of [false, true]) {
    for (const recovery of ["same", "restart"] as const) {
      for (const failure of failures) {
        const storage = new MemoryStorage()
        // Two lifetime targets: one priced and one legacy-unknown.
        const legacy = new DirectUsageLedger(storage as unknown as StorageDomain, { now: () => 0 })
        await legacy.record(input("legacy", 1_000_000, 0, "legacy-model"))
        const priced = new DirectUsageLedger(storage as unknown as StorageDomain, {
          now: () => 0, apiPrice: async () => priceA,
        })
        await priced.record(input("priced", 1_000_000))
        const clock = DAY_MS + 1
        const ledger = new DirectUsageLedger(storage as unknown as StorageDomain, {
          now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
        })
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

        const target = recovery === "same" ? ledger : new DirectUsageLedger(storage as unknown as StorageDomain, {
          now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
        })
        let snap = await target.snapshot()
        assertMixed(snap, storage, label)
        // A replay of the folded call must not add money or counts again.
        await target.record(input("priced", 2_000_000))
        snap = await target.snapshot()
        assertMixed(snap, storage, label)
      }
    }
  }
})

test("queued snapshots fold once and see the same totals", async () => {
  const storage = new MemoryStorage()
  let clock = 0
  const ledger = new DirectUsageLedger(storage as unknown as StorageDomain, {
    now: () => clock, retentionMs: 50, apiPrice: async () => priceA,
  })
  await ledger.record(input("a", 1_000_000))
  await ledger.record(input("b", 1_000_000))
  clock = DAY_MS + 1
  const [first, second] = await Promise.all([ledger.snapshot(), ledger.snapshot()])
  for (const snap of [first, second]) {
    assert.equal(snap.records.length, 0)
    assert.equal(snap.lifetime.length, 1)
    assert.equal(snap.lifetime[0]?.records, 2)
    assert.equal(snap.lifetime[0]?.apiCost?.total, 4)
  }
})

test("malformed money fails closed and is never deleted", async () => {
  const storage = new MemoryStorage()
  const raw = directUsageFromInput(input("bad-price", 1_000_000), 10)
  const rawKey = `${RAW}${encodeURIComponent(JSON.stringify(["project-a", "opr", "bad-price"]))}`
  storage.values.set(rawKey, {
    ...raw, apiPrice: { recordedAt: 10, source: "catalog", prices: "not-rows" },
  })
  const ledger = new DirectUsageLedger(storage as unknown as StorageDomain, {
    now: () => DAY_MS + 1, retentionMs: 50,
  })
  await assert.rejects(ledger.snapshot())
  assert.equal(storage.values.has(rawKey), true)

  storage.values.delete(rawKey)
  const lifetimeKey = `${LIFETIME}${encodeURIComponent(JSON.stringify([
    "project-a", "opr", "openai", "gpt-6-luna", null,
  ]))}`
  storage.values.set(lifetimeKey, { version: 1 })
  const valid = directUsageFromInput(input("valid", 1_000_000), 10)
  const validKey = `${RAW}${encodeURIComponent(JSON.stringify(["project-a", "opr", "valid"]))}`
  storage.values.set(validKey, valid)
  await assert.rejects(ledger.snapshot())
  assert.equal(storage.values.has(validKey), true)
})
