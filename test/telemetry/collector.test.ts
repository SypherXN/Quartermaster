import assert from "node:assert/strict"
import test from "node:test"
import type { Schema } from "effect"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { consumeTokenEvents } from "../../src/telemetry/collector.ts"
import { CompactionLedger } from "../../src/telemetry/compaction.ts"
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
  // A child session names the dispatched subagent, which its messages do not.
  assert.equal(record.hostAgentID, "current-agent")
  assert.equal(record.counts?.input, 4)
  assert.doesNotMatch(JSON.stringify(record), /never persist|prompt/)
})

test("collector names a dispatched subagent from its child session, not the invoking agent", async () => {
  const storage = new MemoryStorage()
  const ctx = {
    event: {} as never,
    storage,
    session: {
      get: async () => ({ projectID: "project-a", parentID: "root-session", agent: "explorer" }) as never,
      context: async () => [{ type: "assistant", id: "message-a", agent: "orchestrator" }] as never,
    },
  }

  await consumeTokenEvents(ctx, new TokenLedger(storage), events(), new AbortController().signal)

  const [record] = await new TokenLedger(storage).list({ projectID: "project-a" })
  assert.equal(record.hostAgentID, "explorer")
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

test("collector falls back to the assistant message's own model when the step start was missed", async () => {
  const storage = new MemoryStorage()
  await consumeTokenEvents({
    event: {} as never,
    storage,
    session: {
      get: async () => ({ projectID: "project-a" }) as never,
      context: async () => [
        { type: "assistant", id: "message-a", agent: "reviewer", model: { providerID: "cursor", id: "grok-4.7", variant: "high" } },
      ] as never,
    },
  }, new TokenLedger(storage), events(), new AbortController().signal)

  const [record] = await new TokenLedger(storage).list({ projectID: "project-a" })
  assert.equal(record.providerID, "cursor")
  assert.equal(record.modelID, "grok-4.7")
  assert.equal(record.variant, "high")
})

test("collector binds a step to this instance's project when the host has none", async () => {
  const storage = new MemoryStorage()
  await consumeTokenEvents({
    event: {} as never,
    storage,
    session: {
      get: async () => { throw new Error("session not found") },
      context: async () => [] as never,
    },
  }, new TokenLedger(storage), events(), new AbortController().signal,
    undefined, undefined, undefined, undefined, "project-instance")

  const [record] = await new TokenLedger(storage).list({ projectID: "project-instance" })
  assert.equal(record.hostProjectID, "project-instance")
  assert.deepEqual(await new TokenLedger(storage).list({ projectID: null }), [])
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

test("compaction is stored beside its model and never becomes a step total", async () => {
  const storage = new MemoryStorage()
  const tokenLedger = new TokenLedger(storage)
  const compactionLedger = new CompactionLedger(storage, () => 3_000)
  const eventFor = (id: string, sessionID: string) => ({
    id,
    type: "session.compaction.ended",
    created: 2_500,
    data: {
      sessionID,
      reason: "auto",
      model: { providerID: "provider-b", id: "summarizer" },
      tokens: { input: 800, output: 40, cache: { read: 200, write: 0 } },
      summary: "must not be stored",
    },
  })
  await consumeTokenEvents({
    event: {} as never,
    storage,
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (sessionID === "gone") throw new Error("session gone")
        return { projectID: "project-a" } as never
      },
      context: async () => [] as never,
    },
  }, tokenLedger, events([
    eventFor("cmp-kept", "session-a"),
    eventFor("cmp-unknown", "gone"),
    { id: "deleted", type: "session.deleted", created: 2_600, data: { sessionID: "session-a" } },
  ]), new AbortController().signal, undefined, compactionLedger)

  const steps = await tokenLedger.list()
  const stored = await compactionLedger.list("project-a")
  assert.equal(steps.length, 0)
  assert.equal(stored.length, 1)
  assert.equal(stored[0]?.hostEventID, "cmp-kept")
  assert.equal(stored[0]?.providerID, "provider-b")
  assert.equal(stored[0]?.modelID, "summarizer")
  assert.equal(stored[0]?.counts?.input, 800)
  assert.equal(stored[0]?.partial, true)
  assert.doesNotMatch(JSON.stringify(stored), /must not be stored|summary|session-a/)
  const unknown = [...storage.values.values()].find((value) => (value as { hostEventID?: string }).hostEventID === "cmp-unknown") as { projectID: string | null }
  assert.equal(unknown.projectID, null)
})

test("removes unattributed compaction rows and keeps attributed ones", async () => {
  const storage = new MemoryStorage()
  const ledger = new CompactionLedger(storage, () => 3_000)
  const recordFor = (hostEventID: string, providerID: string | null) => ({
    hostEventID,
    projectID: "project-a",
    sessionKey: null,
    sourceEvent: "session.compaction.ended" as const,
    reason: null,
    providerID,
    modelID: providerID ? "summarizer" : null,
    variant: null,
    completedAt: 2_500,
    counts: { input: 800, output: 40, reasoning: 0, cacheRead: 200, cacheWrite: 0 },
    usageStatus: "reported" as const,
    partial: false,
  })
  await ledger.ingest(recordFor("cmp-unknown-model", null))
  await ledger.ingest(recordFor("cmp-known-model", "provider-b"))

  const removed = await ledger.removeUnattributed({ projectID: "project-a" })

  assert.deepEqual(removed, { compactions: 1, compactionTokens: 840 })
  assert.deepEqual((await ledger.list("project-a")).map((row) => row.hostEventID), ["cmp-known-model"])
})

const timingEpoch = 2_000_000_000_000
const timingEvent = (
  type: string, id: string, ms: number, message: string, data: Record<string, unknown> = {}, session = "s",
) => ({ type: `session.${type}`, id, created: timingEpoch + ms, data: { sessionID: session, assistantMessageID: message, ...data } })
const timingStart = (id: string, ms: number, message: string, overrides = {}, session?: string) =>
  timingEvent("step.started", id, ms, message, {
    model: { providerID: "p", id: id, variant: "fast" }, started: timingEpoch + ms, ...overrides,
  }, session)
const timingEnd = (id: string, ms: number, message: string, overrides = {}, session?: string) =>
  timingEvent("step.ended", id, ms, message, {
    finish: "stop", tokens: { input: 3, output: 32 }, ...overrides,
  }, session)
const timingDelta = (id: string, ms: number, message: string, delta = "discard-this-text", session?: string) =>
  timingEvent("text.delta", id, ms, message, { delta, ordinal: 0 }, session)

async function collectTimings(items: readonly unknown[]) {
  const storage = new MemoryStorage()
  const ledger = new TokenLedger(storage)
  await consumeTokenEvents({
    event: {} as never,
    storage,
    session: {
      get: async () => ({ projectID: "project" }) as never,
      context: async () => [{ type: "assistant", id: "missing", model: { providerID: "p", id: "fallback" } }] as never,
    },
  }, ledger, events(items), new AbortController().signal)
  const rows = await ledger.list()
  assert.doesNotMatch(JSON.stringify([...storage.values.values()]), /discard-this-text/)
  return Object.fromEntries(rows.map((row) => [row.hostEventID, row]))
}

test("captures independent step rate and first nonempty visible delta per live model", async () => {
  const a = timingStart("start-a", 1, "a", { started: timingEpoch }, "left")
  const end = timingEnd("end-a", 1_000, "a", {}, "left")
  const rows = await collectTimings([
    a, a,
    timingStart("start-b", 2, "b", {}, "right"),
    timingEvent("reasoning.delta", "reason", 4, "a", { delta: "discard-this-text" }, "left"),
    timingDelta("empty", 5, "a", "", "left"),
    timingDelta("first", 32, "a", undefined, "left"),
    timingDelta("second", 64, "a", undefined, "left"),
    timingEvent("step.streamed", "boundary", 500, "a", {}, "left"),
    timingEvent("step.streamed", "boundary-b", 500, "b", {}, "right"),
    timingEnd("end-b", 1_002, "b", { tokens: { input: 3, output: 0 } }, "right"),
    end, end,
    timingStart("start-c", 1_010, "a", {}, "left"),
    end, // replay must not steal the pending start
    timingDelta("actual-zero", 1_010, "a", undefined, "left"),
    timingEnd("end-c", 1_030, "a", { tokens: undefined }, "left"),
  ])
  assert.deepEqual(rows["end-a"].performance, {
    providerID: "p", modelID: "start-a", variant: "fast",
    // 32 tokens over dispatch -> streamed (500 ms), not the later 1,000 ms terminal.
    histogram: { version: 1, outputTokensPerSecond: { 6144: 1 }, observedTtftMs: { 32: 1 } },
  })
  assert.deepEqual(rows["end-b"].performance?.histogram, { version: 1, outputTokensPerSecond: { 0: 1 } })
  assert.equal(rows["end-c"].modelID, "start-c")
  assert.deepEqual(rows["end-c"].performance?.histogram, { version: 1, observedTtftMs: { 0: 1 } })
  assert.equal(rows["end-c"].usageStatus, "missing")
})

test("timing rejects missing, failed, ambiguous, reversed, or incompatible boundaries without changing usage", async () => {
  const rows = await collectTimings([
    timingDelta("orphan", 1, "missing"),
    timingEnd("no-start", 100, "missing"),
    timingStart("overlap-a", 2, "overlap"), timingStart("overlap-b", 3, "overlap"),
    timingDelta("ambiguous", 4, "overlap"),
    timingEnd("overlap-end-a", 100, "overlap"), timingEnd("overlap-end-b", 101, "overlap"),
    timingStart("valid-again", 102, "overlap"), timingDelta("recovered-text", 110, "overlap"), timingEnd("recovered", 1_102, "overlap"),
    timingStart("fails", 10, "fails"), timingDelta("failed-text", 12, "fails"),
    timingEvent("step.failed", "failed", 40, "fails"),
    timingStart("filtered", 10, "filtered"), timingEnd("filtered-end", 90, "filtered", { finish: "content-filter" }),
    timingStart("retry", 11, "retry"), timingEvent("retry.scheduled", "retry-mark", 12, "retry"),
    timingEnd("retry-end", 90, "retry"),
    timingStart("clock", 15, "clock", { started: Math.floor(timingEpoch / 1_000) }),
    timingEnd("wrong-clock", 40, "clock"),
    timingStart("start-late", 90, "reversed"), timingEnd("reversed-ends", 80, "reversed"),
    timingStart("out-of-order", 30, "order"), timingDelta("seen-later", 60, "order"), timingDelta("seen-earlier", 40, "order"),
    timingEvent("step.streamed", "streamed-order", 500, "order"),
    timingEnd("delta-out-of-order", 1_030, "order"),
    timingDelta("before-start-envelope", 42, "prestart"),
    timingStart("delayed-start", 44, "prestart", { started: timingEpoch + 40 }),
    timingDelta("after-start-envelope", 50, "prestart"),
    timingEvent("step.streamed", "streamed-prestart", 500, "prestart"),
    timingEnd("text-may-belong-to-step", 1_040, "prestart"),
  ])
  for (const id of ["no-start", "overlap-end-a", "overlap-end-b", "failed", "filtered-end", "retry-end", "wrong-clock", "reversed-ends"]) {
    assert.equal(rows[id].performance, undefined, id)
  }
  assert.equal(rows["no-start"].modelID, "fallback")
  assert.equal(rows["overlap-end-a"].modelID, "overlap-a")
  assert.equal(rows["overlap-end-b"].counts?.output, 32)
  assert.equal(rows.recovered.performance?.modelID, "valid-again")
  assert.deepEqual(rows["delta-out-of-order"].performance?.histogram, { version: 1, outputTokensPerSecond: { 6656: 1 } })
  assert.deepEqual(rows["text-may-belong-to-step"].performance?.histogram, { version: 1, outputTokensPerSecond: { 6656: 1 } })
})

test("live timing uses session and message identity independently from token fallback", async () => {
  const rows = await collectTimings([
    timingEnd("no-start", 20, "missing"),
    timingStart("next-observed", 30, "missing"),
    timingDelta("resumed-text", 38, "missing"),
    timingEnd("resumed", 1_030, "missing"),
    timingStart("left-model", 40, "same-message", {}, "left"),
    timingStart("right-model", 40, "same-message", {}, "right"),
    timingDelta("left-text", 48, "same-message", undefined, "left"),
    timingDelta("right-text", 56, "same-message", undefined, "right"),
    timingEnd("right-end", 1_040, "same-message", {}, "right"),
    timingEnd("left-end", 1_040, "same-message", {}, "left"),
  ])
  assert.equal(rows.resumed.modelID, "fallback")
  assert.equal(rows.resumed.performance?.modelID, "next-observed")
  assert.equal(rows["right-end"].performance?.modelID, "right-model")
  assert.deepEqual(rows["right-end"].performance?.histogram.observedTtftMs, { 16: 1 })
  assert.equal(rows["left-end"].performance?.modelID, "left-model")
  assert.deepEqual(rows["left-end"].performance?.histogram.observedTtftMs, { 8: 1 })
})

test("effective rate ends at the provider response-body boundary, not tool settlement", async () => {
  const rows = await collectTimings([
    timingStart("late-start", 0, "late", { started: timingEpoch }),
    timingDelta("late-text", 8, "late"),
    timingEvent("step.streamed", "late-streamed", 1_000, "late"),
    // A tool ran for four more seconds before the step settled.
    timingEnd("late-end", 5_000, "late", { finish: "tool-calls" }),
    timingStart("bare-start", 6_000, "bare", { started: timingEpoch + 6_000 }),
    timingDelta("bare-text", 6_016, "bare"),
    timingEnd("bare-end", 7_000, "bare"),
    timingStart("zero-start", 8_000, "zero", { started: timingEpoch + 8_000 }),
    timingEvent("step.streamed", "zero-streamed", 8_500, "zero"),
    timingEnd("zero-end", 9_000, "zero", { tokens: { input: 3, output: 0 } }),
    timingStart("twice-start", 10_000, "twice", { started: timingEpoch + 10_000 }),
    timingEvent("step.streamed", "twice-a", 10_500, "twice"),
    timingEvent("step.streamed", "twice-b", 10_600, "twice"),
    timingEnd("twice-end", 11_000, "twice"),
    timingStart("same-ms-start", 12_000, "same", { started: timingEpoch + 12_000 }),
    timingEvent("step.streamed", "same-ms-streamed", 12_000, "same"),
    timingEnd("same-ms-end", 13_000, "same"),
  ])
  // 32 tokens / 1 s, not 32 / 5 s.
  assert.deepEqual(rows["late-end"].performance?.histogram, {
    version: 1, outputTokensPerSecond: { 3072: 1 }, observedTtftMs: { 8: 1 },
  })
  // No streamed boundary: the full-step wall time is never substituted.
  assert.deepEqual(rows["bare-end"].performance?.histogram, { version: 1, observedTtftMs: { 16: 1 } })
  assert.deepEqual(rows["zero-end"].performance?.histogram, { version: 1, outputTokensPerSecond: { 0: 1 } })
  assert.equal(rows["twice-end"].performance, undefined)
  assert.equal(rows["same-ms-end"].performance, undefined)
  assert.equal(rows["bare-end"].counts?.output, 32)
})

test("more than 2,000 unterminated or interrupted steps never disable later timing", async () => {
  const abandoned: unknown[] = []
  for (let i = 0; i < 2_100; i++) abandoned.push(timingStart(`open-${i}`, i, `open-${i}`, {}, "crashed"))
  const interrupted: unknown[] = []
  for (let i = 0; i < 2_100; i++) interrupted.push(timingStart(`cut-${i}`, 3_000 + i, `cut-${i}`, {}, "cancelled"))
  const rows = await collectTimings([
    ...abandoned,
    // The first unresolved step was evicted: a later start on its message is not timed,
    // and its late terminal cannot pair with anything.
    timingStart("reuse", 2_500, "open-0", {}, "crashed"),
    timingDelta("reuse-text", 2_510, "open-0", undefined, "crashed"),
    timingEnd("reuse-end", 3_500, "open-0", {}, "crashed"),
    ...interrupted,
    timingEvent("execution.interrupted", "interrupt", 5_500, "none", { reason: "user" }, "cancelled"),
    // A retry on a message whose earlier attempt left no terminal is skipped, then recovers.
    timingStart("retry-a", 6_000, "r", {}, "fresh"),
    timingEvent("retry.scheduled", "retry-mark", 6_010, "r", {}, "fresh"),
    timingStart("retry-b", 6_020, "r", {}, "fresh"),
    timingDelta("retry-b-text", 6_030, "r", undefined, "fresh"),
    timingEnd("retry-b-end", 7_000, "r", {}, "fresh"),
    timingStart("retry-c", 7_100, "r", {}, "fresh"),
    timingDelta("retry-c-text", 7_108, "r", undefined, "fresh"),
    timingEnd("retry-c-end", 8_000, "r", {}, "fresh"),
    // After many abandoned steps a fresh message still gets a full sample.
    timingStart("healthy", 8_100, "healthy", {}, "fresh"),
    timingDelta("healthy-text", 8_116, "healthy", undefined, "fresh"),
    timingEvent("step.streamed", "healthy-streamed", 8_600, "healthy", {}, "fresh"),
    timingEnd("healthy-end", 9_100, "healthy", {}, "fresh"),
    // Replaying that terminal changes nothing.
    timingEnd("healthy-end", 9_100, "healthy", {}, "fresh"),
  ])
  assert.equal(rows["reuse-end"].performance, undefined)
  assert.equal(rows["retry-b-end"].performance, undefined)
  assert.deepEqual(rows["retry-c-end"].performance?.histogram, { version: 1, observedTtftMs: { 8: 1 } })
  assert.equal(rows["healthy-end"].performance?.modelID, "healthy")
  assert.deepEqual(rows["healthy-end"].performance?.histogram, {
    version: 1, outputTokensPerSecond: { 6144: 1 }, observedTtftMs: { 16: 1 },
  })
})

test("an interruption drops open steps and a stale terminal cannot clear the next start", async () => {
  const rows = await collectTimings([
    timingStart("cut-1", 10, "x", {}, "cancelled"),
    timingDelta("abandoned-text", 12, "x", undefined, "cancelled"),
    timingEvent("execution.interrupted", "stop", 20, "x", { reason: "user" }, "cancelled"),
    // Text from the abandoned step that surfaces after the interruption is not reused.
    timingDelta("late-abandoned", 22, "x", undefined, "cancelled"),
    timingStart("next", 30, "x", {}, "cancelled"),
    // The abandoned step's terminal is older than the new start.
    timingEnd("stale-end", 15, "x", {}, "cancelled"),
    timingDelta("next-text", 40, "x", undefined, "cancelled"),
    timingEvent("step.streamed", "next-streamed", 530, "x", {}, "cancelled"),
    timingEnd("next-end", 1_030, "x", {}, "cancelled"),
  ])
  assert.equal(rows["stale-end"].performance, undefined)
  assert.equal(rows["next-end"].performance?.modelID, "next")
  // dispatch -> first text is 10 ms; the abandoned 12 ms and 22 ms deltas never count.
  assert.deepEqual(rows["next-end"].performance?.histogram.observedTtftMs, { 10: 1 })
  assert.deepEqual(rows["next-end"].performance?.histogram.outputTokensPerSecond, { 6144: 1 })
})
