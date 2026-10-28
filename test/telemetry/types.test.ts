import assert from "node:assert/strict"
import test from "node:test"
import { projectTokenEvents } from "../../src/telemetry/types.ts"

function stepEvent(
  id: string,
  type: string,
  data: Record<string, unknown>,
  created = 1_750_000_000_000,
) {
  return { id, created, type, data }
}

function ended(id: string, sessionID = "ses-parent", tokens: unknown = {
  input: 12,
  output: 0,
  reasoning: 3,
  cache: { read: 4, write: 5 },
}) {
  return stepEvent(id, "session.step.ended", {
    sessionID,
    assistantMessageID: "msg-shared",
    tokens,
    prompt: "must not be copied",
    providerState: { apiKey: "must not be copied" },
    permissions: [{ resource: "secret-token", effect: "allow" }],
  })
}

test("projects only terminal step usage and deduplicates repeated event IDs", () => {
  const terminal = ended("evt-end")
  const records = projectTokenEvents([
    stepEvent("evt-start", "session.step.started", { sessionID: "ses-parent", assistantMessageID: "msg-shared" }),
    stepEvent("evt-stream", "session.step.streamed", { sessionID: "ses-parent", assistantMessageID: "msg-shared" }),
    stepEvent("evt-retry", "session.retry.scheduled", { sessionID: "ses-parent", assistantMessageID: "msg-shared" }),
    stepEvent("evt-compaction", "session.compaction.ended", { sessionID: "ses-parent", messageID: "msg-shared", tokens: { input: 1 } }),
    stepEvent("evt-message", "message.updated", { content: "private prompt" }),
    terminal,
    { ...terminal },
  ], (eventID) => eventID === "evt-end"
    ? {
        projectID: "project-main",
        model: { providerID: "provider-test", modelID: "model-test", variant: "fast" },
      }
    : undefined)

  assert.deepEqual(records, [{
    hostContractVersion: "2.0.18",
    hostEventID: "evt-end",
    sourceEvent: "session.step.ended",
    hostSessionID: "ses-parent",
    hostMessageID: "msg-shared",
    hostProjectID: "project-main",
    parentSessionID: null,
    hostAgentID: null,
    providerID: "provider-test",
    modelID: "model-test",
    variant: "fast",
    completedAt: 1_750_000_000_000,
    counts: { input: 12, output: 0, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
    usageStatus: "reported",
    partial: false, hostCostUSD: null,
  }])
  assert.doesNotMatch(JSON.stringify(records), /private|secret-token|apiKey/)
})

test("keeps distinct attempts under one assistant message", () => {
  const records = projectTokenEvents([
    ended("evt-attempt-1"),
    stepEvent("evt-retry", "session.retry.scheduled", { sessionID: "ses-parent", assistantMessageID: "msg-shared" }),
    ended("evt-attempt-2"),
  ])

  assert.deepEqual(records.map((record) => record.hostEventID), ["evt-attempt-1", "evt-attempt-2"])
  assert.ok(records.every((record) => record.hostMessageID === "msg-shared"))
})

test("keeps child-session attribution and tolerates partial token fields", () => {
  const records = projectTokenEvents([
    stepEvent("evt-child-failed", "session.step.failed", {
      sessionID: "ses-child",
      assistantMessageID: "msg-child",
      error: { message: "private error" },
    }),
    ended("evt-partial", "ses-child", { input: 2, output: 0, reasoning: 0, cache: { read: 0 } }),
    stepEvent("evt-no-tokens", "session.step.ended", {
      sessionID: "ses-child",
      assistantMessageID: "msg-child",
    }),
  ], (_eventID, sessionID) => sessionID === "ses-child"
    ? { projectID: "project-main", parentSessionID: "ses-parent" }
    : undefined)

  assert.equal(records.length, 3)
  const failed = records.find((row) => row.hostEventID === "evt-child-failed")
  const partial = records.find((row) => row.hostEventID === "evt-partial")
  const missing = records.find((row) => row.hostEventID === "evt-no-tokens")
  assert.ok(failed && partial && missing)

  for (const row of [failed, partial, missing]) {
    assert.equal(row.hostSessionID, "ses-child")
    assert.equal(row.hostProjectID, "project-main")
    assert.equal(row.parentSessionID, "ses-parent")
    assert.equal(row.providerID, null)
    assert.equal(row.modelID, null)
    assert.equal(row.variant, null)
  }
  assert.equal(failed.counts, null)
  assert.equal(failed.usageStatus, "missing")
  assert.equal(failed.partial, false)

  assert.equal(partial.usageStatus, "reported")
  assert.equal(partial.partial, true)
  assert.equal(partial.counts?.cacheWrite, 0)

  assert.equal(missing.counts, null)
  assert.equal(missing.usageStatus, "missing")
  assert.equal(missing.partial, false)
  assert.doesNotMatch(JSON.stringify(records), /private error/)
})
