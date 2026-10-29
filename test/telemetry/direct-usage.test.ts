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

test("pruned direct-usage rows keep one daily total per project", async () => {
  const storage = new MemoryStorage()
  const start = 2_000_000_000_000
  let now = start
  const ledger = new DirectUsageLedger(storage, () => now, 1_000, 10)
  await ledger.record(input("project-a", "day-one", { input: 100, output: 20 }))
  now = start + DAY_MS
  await ledger.record(input("project-a", "day-two", { input: 4, output: 6, reasoning: 1, cacheRead: 2, cacheWrite: 3 }))
  await ledger.record(input("project-b", "other-project", { input: 999, output: 1 }))
  now = start + DAY_MS + 5_000
  await ledger.record(input("project-a", "fresh", { input: 5, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 }))

  const rows = await ledger.list("project-a")
  assert.deepEqual(rows.map((row) => row.usageID), ["fresh"])
  const rollups = await ledger.listRollups("project-a")
  assert.deepEqual(rollups.map((rollup) => ({
    day: rollup.day, records: rollup.records, observedTokens: rollup.observedTokens,
    partialRecords: rollup.partialRecords, input: rollup.input, output: rollup.output,
    reasoning: rollup.reasoning, cacheRead: rollup.cacheRead, cacheWrite: rollup.cacheWrite,
  })), [
    {
      day: Math.floor(start / DAY_MS) * DAY_MS, records: 1, observedTokens: 120, partialRecords: 1,
      input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0,
    },
    {
      day: Math.floor((start + DAY_MS) / DAY_MS) * DAY_MS, records: 1, observedTokens: 10, partialRecords: 0,
      input: 4, output: 6, reasoning: 1, cacheRead: 2, cacheWrite: 3,
    },
  ])
  assert.equal(JSON.stringify(rollups).includes("day-one"), false)
  assert.equal((await ledger.listRollups("project-b")).length, 0)
  const stored = [...storage.values.values()].filter((value) =>
    value !== null && typeof value === "object" && "usageID" in value) as Array<{ usageID: string }>
  assert.deepEqual(stored.map((row) => row.usageID).sort(), ["fresh", "other-project"])
  await ledger.list("project-a")
  assert.deepEqual((await ledger.listRollups("project-a")).map((rollup) => rollup.records), [1, 1])
})

test("the row cap archives the oldest call and a replacement is archived once", async () => {
  const storage = new MemoryStorage()
  const start = 2_000_000_000_000
  let now = start
  const ledger = new DirectUsageLedger(storage, () => now, 10_000, 1)
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
  assert.equal((await ledger.listRollups("project-a")).length, 0)

  now = start + 20
  await ledger.record(input("project-a", "newer", { input: 3, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }))
  assert.deepEqual((await ledger.list("project-a")).map((row) => row.usageID), ["newer"])
  const rollups = await ledger.listRollups("project-a")
  assert.equal(rollups.length, 1)
  assert.equal(rollups[0]?.records, 1)
  assert.equal(rollups[0]?.input, 7)
  assert.equal(rollups[0]?.output, 2)
  assert.equal(rollups[0]?.observedTokens, 9)
  assert.equal(rollups[0]?.partialRecords, 0)
  await ledger.list("project-a")
  assert.equal((await ledger.listRollups("project-a"))[0]?.records, 1)
})
