import assert from "node:assert/strict"
import test from "node:test"
import type { Schema } from "effect"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { DirectUsageLedger, type DirectUsageInput } from "../../src/telemetry/direct-usage.ts"

const DAY_MS = 86_400_000

class MemoryStorage implements StorageDomain {
  values = new Map<string, Schema.Json>()
  async get(key: string) { return this.values.get(key) }
  async set(key: string, value: Schema.Json) { this.values.set(key, value) }
  async remove(key: string) { this.values.delete(key) }
  async scan(options: Parameters<StorageDomain["scan"]>[0]) {
    const keys = [...this.values.keys()].filter((key) => key.startsWith(options.prefix) && (!options.after || key > options.after)).sort()
    const page = keys.slice(0, options.limit ?? 100)
    return { entries: page.map((key) => ({ key, value: this.values.get(key)! })), ...(keys.length > page.length ? { next: page.at(-1)! } : {}) }
  }
}

function input(projectID: string, usageID: string, counts: DirectUsageInput["counts"], pluginID = "opr"): DirectUsageInput {
  return {
    projectID, pluginID, pluginName: pluginID === "opr" ? "OPR" : pluginID,
    usageID, providerID: "opencode", modelID: "jev", counts,
  }
}

test("expired direct-usage calls fold into one lifetime total per project, plugin, and model", async () => {
  const storage = new MemoryStorage()
  const start = 2_000_000_000_000
  let now = start
  const ledger = new DirectUsageLedger(storage, () => now, 1_000)
  await ledger.record(input("project-a", "day-one", { input: 100, output: 20 }))
  now = start + DAY_MS
  await ledger.record(input("project-a", "day-two", { input: 4, output: 6, reasoning: 1, cacheRead: 2, cacheWrite: 3 }))
  await ledger.record(input("project-b", "other-project", { input: 999, output: 1 }))
  now = start + 2 * DAY_MS
  await ledger.record(input("project-a", "fresh", { input: 5, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 }))

  assert.deepEqual((await ledger.list("project-a")).map((row) => row.usageID), ["fresh"])
  assert.deepEqual(await ledger.listRollups("project-a"), [])
  // Both expired calls share one plugin and model, so they share one row.
  const lifetime = await ledger.listLifetime("project-a")
  assert.deepEqual(lifetime.map((row) => ({
    pluginID: row.pluginID, modelID: row.modelID, records: row.records,
    observedTokens: row.observedTokens, partialRecords: row.partialRecords,
    input: row.input, output: row.output, reasoning: row.reasoning,
    cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, unknownCacheRecords: row.unknownCacheRecords,
  })), [{
    pluginID: "opr", modelID: "jev", records: 2, observedTokens: 130, partialRecords: 1,
    input: 104, output: 26, reasoning: 1, cacheRead: 2, cacheWrite: 3, unknownCacheRecords: 1,
  }])
  assert.equal(JSON.stringify(lifetime).includes("day-one"), false)
  // The other project's call is just as old, and folds into its own total.
  assert.deepEqual((await ledger.listLifetime("project-b")).map((row) => row.observedTokens), [1000])
  const stored = [...storage.values.values()].filter((value) =>
    value !== null && typeof value === "object" && "usageID" in value) as Array<{ usageID: string }>
  assert.deepEqual(stored.map((row) => row.usageID), ["fresh"])
  await ledger.list("project-a")
  assert.equal((await ledger.listLifetime("project-a"))[0]?.records, 2)
})

test("a replacement is folded once when it expires", async () => {
  const storage = new MemoryStorage()
  const start = 2_000_000_000_000
  let now = start
  const ledger = new DirectUsageLedger(storage, () => now, 10_000)
  await ledger.record(input("project-a", "same", { input: 100, output: 1 }))
  now = start + 10
  const replaced = await ledger.record(input("project-a", "same", {
    input: 7, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0,
  }))
  assert.equal(replaced.replaced, true)
  const replacedRows = await ledger.list("project-a")
  assert.equal(replacedRows.length, 1)
  assert.equal(replacedRows[0]?.counts.input, 7)
  assert.equal(replacedRows[0]?.reportedAt, start)
  assert.equal((await ledger.listLifetime("project-a")).length, 0)

  now = start + DAY_MS
  await ledger.record(input("project-a", "newer", { input: 3, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }))
  assert.deepEqual((await ledger.list("project-a")).map((row) => row.usageID), ["newer"])
  const lifetime = await ledger.listLifetime("project-a")
  assert.equal(lifetime.length, 1)
  assert.equal(lifetime[0]?.records, 1)
  assert.equal(lifetime[0]?.input, 7)
  assert.equal(lifetime[0]?.output, 2)
  assert.equal(lifetime[0]?.observedTokens, 9)
  assert.equal(lifetime[0]?.partialRecords, 0)
  await ledger.list("project-a")
  assert.equal((await ledger.listLifetime("project-a"))[0]?.records, 1)
})

test("direct pruning scans once per day and keeps pending expiry in totals", async () => {
  const storage = new MemoryStorage()
  let scans = 0
  const scan = storage.scan.bind(storage)
  storage.scan = async (options) => { scans++; return scan(options) }
  let now = 2_000_000_000_000
  const ledger = new DirectUsageLedger(storage, () => now, 100)
  await ledger.record(input("project-a", "aging", { input: 10, output: 2 }))
  const initialScans = scans
  now += DAY_MS - 1
  await ledger.record(input("project-a", "fresh", { input: 5, output: 1 }))
  assert.equal(scans, initialScans)
  assert.equal((await ledger.list("project-a")).length, 2)
  assert.equal(scans, initialScans + 1)
  now += 1
  await ledger.list("project-a")
  assert.equal((await ledger.listLifetime("project-a"))[0].records, 1)
  assert.deepEqual((await ledger.list("project-a")).map((row) => row.usageID), ["fresh"])
})
