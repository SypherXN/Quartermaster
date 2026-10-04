import assert from "node:assert/strict"
import test from "node:test"
import type { Schema } from "effect"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { consumeTokenEvents } from "../../src/telemetry/collector.ts"
import { TokenLedger } from "../../src/telemetry/ledger.ts"

class MemoryStorage implements StorageDomain {
  values = new Map<string, Schema.Json>()
  failNextSet = false

  async get(key: string) { return this.values.get(key) }
  async set(key: string, value: Schema.Json) {
    if (this.failNextSet) {
      this.failNextSet = false
      throw new Error("synthetic write failure")
    }
    this.values.set(key, value)
  }
  async remove(key: string) { this.values.delete(key) }
  async scan({ prefix, after, limit = 100 }: Parameters<StorageDomain["scan"]>[0]) {
    const keys = [...this.values.keys()].filter((key) => key.startsWith(prefix) && (!after || key > after)).sort()
    const page = keys.slice(0, limit)
    return {
      entries: page.map((key) => ({ key, value: this.values.get(key)! })),
      ...(keys.length > limit && page.length ? { next: page[page.length - 1] } : {}),
    }
  }
}

async function* events(items: readonly unknown[] = [
  { id: "start", type: "session.step.started", created: 1, data: { sessionID: "session-a" } },
  {
    id: "step-ended",
    type: "session.step.ended",
    created: 2_000_000_000_000,
    data: {
      sessionID: "session-a",
      assistantMessageID: "message-a",
      tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      prompt: "never persist",
    },
  },
]) {
  yield* items
}

test("collector attributes the exact assistant message without inferring its model", async () => {
  const storage = new MemoryStorage()
  const sessionLookups: string[] = []
  const ctx = {
    event: {} as never,
    storage,
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        sessionLookups.push(sessionID)
        return { projectID: "project-a", parentID: "parent-session", agent: "current-agent", model: { providerID: "provider-a", modelID: "model-a" } } as never
      },
      context: async () => [
        { type: "assistant", id: "another-message", agent: "wrong-agent" },
        { type: "assistant", id: "message-a", agent: "reviewer" },
      ] as never,
    },
  }

  await consumeTokenEvents(ctx, new TokenLedger(storage), events(), new AbortController().signal)

  assert.deepEqual(sessionLookups, ["session-a"])
  const [record] = await new TokenLedger(storage).list({ projectID: "project-a" })
  assert.equal(record.parentSessionID, "parent-session")
  assert.equal(record.providerID, null)
  assert.equal(record.modelID, null)
  assert.equal(record.hostAgentID, "reviewer")
  assert.equal(record.counts?.input, 4)
  assert.doesNotMatch(JSON.stringify(record), /never persist|prompt/)
})

test("collector keeps usage when session attribution lookup fails", async () => {
  const storage = new MemoryStorage()
  const ctx = {
    event: {} as never,
    storage,
    session: {
      get: async () => { throw new Error("session unavailable") },
      context: async () => { throw new Error("context unavailable") },
    },
  }

  await consumeTokenEvents(ctx, new TokenLedger(storage), events(), new AbortController().signal)

  const [record] = await new TokenLedger(storage).list()
  assert.equal(record.hostProjectID, null)
  assert.equal(record.hostAgentID, null)
  assert.equal(record.counts?.input, 4)
})

test("agent switches and child-session steps match only their exact message IDs", async () => {
  const storage = new MemoryStorage()
  const steps = [
    { id: "step-one", created: 2_000_000_000_000, type: "session.step.ended", data: { sessionID: "parent", assistantMessageID: "message-one", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
    { id: "step-two", created: 2_000_000_000_000, type: "session.step.ended", data: { sessionID: "parent", assistantMessageID: "message-two", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
    { id: "child-step", created: 2_000_000_000_000, type: "session.step.ended", data: { sessionID: "child", assistantMessageID: "child-message", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
    { id: "missing-step", created: 2_000_000_000_000, type: "session.step.ended", data: { sessionID: "child", assistantMessageID: "missing-message", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
  ]
  await consumeTokenEvents({
    event: {} as never,
    storage,
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ projectID: "project-a", parentID: sessionID === "child" ? "parent" : null }) as never,
      context: async ({ sessionID }: { sessionID: string }) => sessionID === "parent"
        ? [{ type: "assistant", id: "message-one", agent: "reviewer" }, { type: "assistant", id: "message-two", agent: "writer" }] as never
        : [{ type: "assistant", id: "child-message", agent: "reviewer" }] as never,
    },
  }, new TokenLedger(storage), events(steps), new AbortController().signal)

  const rows = await new TokenLedger(storage).list({ projectID: "project-a" })
  assert.deepEqual(Object.fromEntries(rows.map(({ hostEventID, hostAgentID }) => [hostEventID, hostAgentID])), {
    "step-one": "reviewer", "step-two": "writer", "child-step": "reviewer", "missing-step": null,
  })
  assert.equal(rows.find(({ hostEventID }) => hostEventID === "child-step")?.parentSessionID, "parent")
})

test("collector retries a failed idempotent write once", async () => {
  const storage = new MemoryStorage()
  storage.failNextSet = true
  const ctx = {
    event: {} as never,
    storage,
    session: { get: async () => ({ projectID: "project-a" }) as never, context: async () => [] as never },
  }

  await consumeTokenEvents(ctx, new TokenLedger(storage), events(), new AbortController().signal)

  const records = await new TokenLedger(storage).list({ projectID: "project-a" })
  assert.equal(records.length, 1)
  assert.equal(records[0].counts?.input, 4)
})

test("collector refresh callback runs after a token record is persisted", async () => {
  const storage = new MemoryStorage()
  const ledger = new TokenLedger(storage)
  let observedRecords = 0
  await consumeTokenEvents(
    {
      event: {} as never,
      storage,
      session: { get: async () => ({ projectID: "project-a" }) as never, context: async () => [] as never },
    },
    ledger,
    events(),
    new AbortController().signal,
    async () => { observedRecords = (await ledger.list({ projectID: "project-a" })).length },
  )

  assert.equal(observedRecords, 1)
})
