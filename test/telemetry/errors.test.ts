import assert from "node:assert/strict"
import test from "node:test"
import type { Schema } from "effect"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import {
  projectRetryError,
  ProviderErrorLedger,
  startProviderErrorCollector,
} from "../../src/telemetry/errors.ts"

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

const event = (status: number | undefined, providerID = "provider-a", modelID = "model-a") => ({
  sessionID: "host-session",
  model: { providerID, id: modelID },
  error: { type: "secret-error-type", message: "secret response body", status },
  attempt: 1,
  decision: { retry: false as const },
})

test("retry projection classifies known status and keeps provider/model and time", () => {
  const rateLimit = projectRetryError(event(429), "event-1", 123)
  assert.deepEqual(rateLimit, {
    id: "event-1", observedAt: 123, source: "session.retry", projectID: null, classification: "rate-limit",
    httpStatus: 429, providerID: "provider-a", modelID: "model-a", attempt: 1,
  })
  assert.equal(projectRetryError(event(undefined), "event-2", 124)?.classification, "unknown")
  assert.equal(projectRetryError(event(302), "event-redirect", 124)?.classification, "unknown")
  assert.equal(projectRetryError(event(503), "event-3", 125)?.classification, "provider-error")
  assert.equal(projectRetryError(event(400), "event-4", 125)?.classification, "request-error")
  assert.equal(projectRetryError(event(400, "", ""), "event-4", 126)?.providerID, null)
  assert.equal(projectRetryError({ ...event(429), attempt: 0 }, "bad", 1), undefined)
})

test("ledger upserts duplicate hook records, filters by time/provider/model, and prunes bounds", async () => {
  const storage = new MemoryStorage()
  const now = 10_000
  const ledger = new ProviderErrorLedger(storage, () => now, 100, 2)
  await ledger.ingest(projectRetryError(event(429), "same", now - 3)!)
  await ledger.ingest(projectRetryError(event(503), "same", now - 3)!)
  await ledger.ingest(projectRetryError(event(429, "provider-b", "model-b"), "newer", now - 2)!)
  await ledger.ingest(projectRetryError(event(400), "latest", now - 1)!)
  await ledger.ingest(projectRetryError(event(429), "expired", now - 101)!)

  const rows = await ledger.list({ since: now - 2, providerID: "provider-a", modelID: "model-a" })
  assert.deepEqual(rows.map((row) => row.id), ["latest"])
  assert.equal((await ledger.list()).length, 2)
  assert.equal(storage.values.size, 2)
  assert.doesNotMatch(JSON.stringify([...storage.values.values()]), /secret|message|error-type/)
})

test("retry hook persists observed metadata without changing retry behavior", async () => {
  const storage = new MemoryStorage()
  let callback: ((value: unknown) => Promise<void>) | undefined
  let disposed = false
  const collector = await startProviderErrorCollector({
    storage,
    session: {
      get: async () => ({ projectID: "project-a" }),
      hook: async (_name: "retry", handler: (value: never) => void) => {
      callback = handler as (value: unknown) => Promise<void>
      return { dispose: async () => { disposed = true } }
      },
    },
  } as never)
  const retry = event(429)
  await callback!(retry)
  assert.deepEqual(retry.decision, { retry: false })
  assert.equal([...storage.values.values()].length, 1)
  assert.equal([...storage.values.values()][0] && ([...storage.values.values()][0] as { projectID: string }).projectID, "project-a")
  assert.doesNotMatch(JSON.stringify([...storage.values.values()]), /secret/)
  await collector.dispose()
  assert.equal(disposed, true)
})

test("no observed retry hook event produces no fabricated error row", async () => {
  const storage = new MemoryStorage()
  const collector = await startProviderErrorCollector({
    storage,
    session: { hook: async () => ({ dispose() {} }) },
  } as never)
  assert.equal(storage.values.size, 0)
  await collector.dispose()
})

test("retry remains recorded but unattributed when session lookup fails", async () => {
  const storage = new MemoryStorage()
  let callback: ((value: unknown) => Promise<void>) | undefined
  const collector = await startProviderErrorCollector({
    storage,
    session: {
      get: async () => { throw new Error("unavailable") },
      hook: async (_name: "retry", handler: (value: never) => void) => {
        callback = handler as (value: unknown) => Promise<void>
        return { dispose: async () => {} }
      },
    },
  } as never)
  await callback!(event(429))
  const rows = await collector.ledger.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].projectID, null)
  await collector.dispose()
})
