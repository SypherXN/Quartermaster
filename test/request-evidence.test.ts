import assert from "node:assert/strict"
import test from "node:test"
import { RequestEvidenceHistory } from "../src/request-evidence.ts"

test("bounded evidence attributes delayed errors without guessing across overlaps", () => {
  const history = new RequestEvidenceHistory(100, 2)
  const first = { sessionID: "a", kind: "compaction" as const, agent: "old", model: { providerID: "p", modelID: "old" }, observedAt: 10, managed: true }
  history.record(first, 10)
  history.end("a", "compaction", 20, 20)
  history.record({ ...first, agent: "new", model: { providerID: "p", modelID: "new" }, observedAt: 30 }, 30)
  assert.equal(history.match("a", "compaction", 19, 40), first)
  assert.equal(history.match("a", "primary", 19, 40), undefined)
  assert.equal(history.match("a", "compaction", NaN, 40), undefined)
  assert.equal(history.match("a", "compaction", 41, 40), undefined)
  history.record({ ...first, observedAt: 31 }, 31)
  assert.equal(history.match("a", "compaction", 32, 40), undefined)
  assert.equal(history.match("a", "compaction", 19, 40), undefined, "old evidence evicted at capacity")
  assert.equal(history.match("a", "compaction", 32, 140), undefined)
  history.delete("a")
  assert.equal(history.match("a", "compaction", 32, 40), undefined)
})

test("same-model evidence is sufficient for cooldowns, never for distinguishing requests", () => {
  const history = new RequestEvidenceHistory(100, 3)
  const row = { sessionID: "a", kind: "primary" as const, agent: "agent", model: { providerID: "p", modelID: "m", variant: "v" }, observedAt: 10, managed: true }
  history.record(row, 10)
  history.record({ ...row, observedAt: 11 }, 11)
  assert.equal(history.match("a", "primary", 12, 20), row)
  assert.equal(history.claimFailure("a", "primary", 12, 20), true)
  assert.equal(history.claimFailure("a", "primary", 12, 21), false)
  assert.equal(history.claimFailure("a", "compaction", 12, 21), true)
  history.record({ ...row, observedAt: 12, managed: false }, 12)
  assert.equal(history.match("a", "primary", 13, 20), undefined)
  history.end("a", "primary", Infinity, 20)
  history.clear()
  assert.equal(history.match("a", "primary", 12, 20), undefined)
})
