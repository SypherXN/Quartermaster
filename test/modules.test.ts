import type { UsageReadResult, UsageSource } from "../src/usage.ts"
import assert from "node:assert/strict"
import test from "node:test"
import { parseConfig } from "../src/config.ts"
import { FailureCooldowns } from "../src/failures.ts"
import { MODULE_COOLDOWN_STORAGE_KEY, ModuleCooldowns } from "../src/modules.ts"
import { modelKey, selectModel } from "../src/select.ts"

const free = { providerID: "opencode", modelID: "jev-free" }
const paid = { providerID: "opencode", modelID: "jev-paid" }
const report = { module: "opr", ...free, reason: "rate-limit" as const }
const storageKey = (project: string) => `${MODULE_COOLDOWN_STORAGE_KEY}/${encodeURIComponent(project)}`
const config = () => parseConfig({
  providerCooldownMs: 100,
  modules: {
    opr: { models: [{ id: "opencode/jev-free", variant: "fast", cooldownMs: 200 }, "opencode/jev-paid"] },
    other: { models: ["opencode/jev-free"] },
  },
})

function memory() {
  const values = new Map<string, unknown>()
  const writes: { key: string; value: unknown }[] = []
  return {
    values, writes,
    storage: {
      get: async (key: string) => structuredClone(values.get(key)),
      set: async (key: string, value: unknown) => {
        writes.push({ key, value: structuredClone(value) })
        values.set(key, structuredClone(value))
      },
    },
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test("module cooldowns use configured durations, extend deadlines, and expire exactly", async () => {
  const store = memory()
  let now = 10
  const state = await ModuleCooldowns.load(config(), store.storage, "project", () => now)
  assert.deepEqual(await state.report(report), { accepted: true, module: "opr", ...free, blockedUntil: 210 })
  assert.deepEqual(state.snapshot("opr"), [{ ...free, until: 210 }])
  assert.deepEqual(state.snapshot("other"), [])
  await state.report({ ...report, ...paid, reason: "temporary-unavailable" })
  assert.deepEqual(state.snapshot("opr"), [{ ...free, until: 210 }, { ...paid, until: 110 }])
  now = 50
  await state.report(report)
  now = 20
  const extended = await state.report(report)
  assert.ok(extended.accepted)
  assert.equal(extended.blockedUntil, 250)
  now = 249
  assert.deepEqual(state.snapshot("opr"), [{ ...free, until: 250 }])
  now = 250
  assert.deepEqual(state.snapshot("opr"), [])
})

test("module state is separate from projects, variants, native cooldowns and caller snapshots", async () => {
  const store = memory()
  store.values.set("availability/cooldowns-v1", { cooldowns: [{ ...paid, until: 999 }] })
  const alpha = await ModuleCooldowns.load(config(), store.storage, "a/b", () => 10)
  const beta = await ModuleCooldowns.load(config(), store.storage, "a%2Fb", () => 10)
  await alpha.report(report)
  await beta.report({ ...report, module: "other" })
  assert.deepEqual(alpha.snapshot("other"), [])
  assert.deepEqual(beta.snapshot("opr"), [])
  assert.equal(beta.snapshot("other")[0].until, 110)
  const restarted = await ModuleCooldowns.load(config(), store.storage, "a/b", () => 10)
  assert.deepEqual(restarted.snapshot("opr"), [{ ...free, until: 210 }])
  const changedVariant = config()
  changedVariant.modules!.opr.models[0].variant = "slow"
  assert.deepEqual((await ModuleCooldowns.load(changedVariant, store.storage, "a/b", () => 10)).snapshot("opr"), [{ ...free, until: 210 }])
  const native = new FailureCooldowns(100)
  native.reportFailure({ ...free, classification: "model-outage" }, 10)
  native.reportSuccess({ ...free, scope: "model" })
  const detached = alpha.snapshot("opr")
  detached[0].until = 0
  detached.length = 0
  assert.equal(alpha.snapshot("opr")[0].until, 210, "success in the native path and stale snapshots cannot clear module limits")
  assert.deepEqual(store.values.get("availability/cooldowns-v1"), { cooldowns: [{ ...paid, until: 999 }] })
  assert.deepEqual(store.writes.map(w => w.key), [storageKey("a/b"), storageKey("a%2Fb")])
})

test("unknown scopes, invalid reasons and unsafe clock arithmetic cannot mutate cooldowns", async () => {
  const store = memory()
  let now = 10
  const state = await ModuleCooldowns.load(config(), store.storage, "project", () => now)
  for (const module of ["missing", "toString", "__proto__"]) {
    assert.deepEqual(await state.report({ ...report, module }), { accepted: false, reason: "unknown-module" })
    assert.deepEqual(state.snapshot(module), [])
  }
  assert.deepEqual(await state.report({ ...report, modelID: "missing" }), { accepted: false, reason: "unknown-model" })
  await assert.rejects(state.report({ ...report, reason: "auth" as never }), /reason/)
  for (const clock of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    now = clock
    await assert.rejects(state.report(report), /clock|deadline/)
  }
  now = 10
  assert.deepEqual(state.snapshot("opr"), [])
  assert.deepEqual(store.writes, [])
  await assert.rejects(ModuleCooldowns.load(config(), store.storage, " ", () => 10), /project/)
  const huge = parseConfig({ modules: { opr: { models: [{ id: "opencode/jev-free", cooldownMs: Number.MAX_SAFE_INTEGER }] } } })
  const overflow = await ModuleCooldowns.load(huge, store.storage, "project", () => 1)
  await assert.rejects(overflow.report(report), /deadline/)
  assert.deepEqual(store.writes, [])
})

test("restore validates metadata, retains longest duplicates and discards expired or unknown entries", async () => {
  const store = memory()
  const row = { module: "opr", ...free, until: 210 }
  store.values.set(storageKey("project"), { cooldowns: [
    row, { ...row, until: 110 }, { ...row, until: 10 }, { ...row, until: 9 },
    { ...row, until: 20.5 }, { ...row, until: Number.POSITIVE_INFINITY },
    { ...row, until: Number.MAX_SAFE_INTEGER + 1 }, { ...row, until: "200" },
    { ...row, module: "unknown" }, { ...row, module: "toString" },
    { ...row, providerID: "unknown" }, { ...row, modelID: "unknown" },
    { module: "opr", providerID: "opencode", until: 210 },
    { ...row, error: "must not be retained" }, null,
  ] })
  const state = await ModuleCooldowns.load(config(), store.storage, "project", () => 10)
  assert.deepEqual(state.snapshot("opr"), [{ ...free, until: 210 }])
  await state.report({ ...report, ...paid })
  assert.deepEqual(store.values.get(storageKey("project")), {
    cooldowns: [row, { module: "opr", ...paid, until: 110 }],
  })
  const expired = await ModuleCooldowns.load(config(), store.storage, "project", () => 210)
  assert.deepEqual(expired.snapshot("opr"), [])
  for (const malformed of [null, [], "bad", { cooldowns: {} }, { cooldowns: [null] }]) {
    store.values.set(storageKey("project"), malformed)
    assert.deepEqual((await ModuleCooldowns.load(config(), store.storage, "project", () => 10)).snapshot("opr"), [])
  }
})

test("concurrent reports update memory immediately and serialize durable acknowledgements", async () => {
  const store = memory()
  const started = deferred()
  const release = deferred()
  const save = store.storage.set
  let calls = 0
  store.storage.set = async (key, value) => {
    calls++
    if (calls === 1) {
      started.resolve()
      await release.promise
    }
    await save(key, value)
  }
  let now = 10
  const state = await ModuleCooldowns.load(config(), store.storage, "project", () => now)
  let acknowledged = false
  const first = state.report(report).then(result => { acknowledged = true; return result })
  await started.promise
  assert.equal(acknowledged, false)
  assert.equal(state.snapshot("opr")[0].until, 210, "eligibility input changes even while storage is pending")
  const selection = state.select("opr")
  assert.equal(selection.status, "selected")
  if (selection.status === "selected") assert.deepEqual(selection.selected, paid)
  now = 50
  const second = state.report(report)
  now = 60
  const third = state.report({ ...report, ...paid })
  assert.equal(state.snapshot("opr")[0].until, 250)
  assert.equal(calls, 1, "newer snapshots cannot race the in-flight write")
  release.resolve()
  await Promise.all([first, second, third])
  assert.equal(calls, 3)
  assert.deepEqual(store.writes.map(w => (w.value as { cooldowns: { until: number }[] }).cooldowns.map(c => c.until)), [[210], [250], [250, 160]])
  assert.deepEqual((await ModuleCooldowns.load(config(), store.storage, "project", () => now)).snapshot("opr"), [
    { ...free, until: 250 }, { ...paid, until: 160 },
  ].sort((a, b) => a.until - b.until))
})

test("storage failures reject reports without unblocking memory or poisoning later saves", async () => {
  const store = memory()
  const save = store.storage.set
  let fail = true
  store.storage.set = async (key, value) => {
    if (fail) throw new Error("synthetic write failure")
    await save(key, value)
  }
  const state = await ModuleCooldowns.load(config(), store.storage, "project", () => 10)
  await assert.rejects(state.report(report), /synthetic write failure/)
  assert.equal(state.snapshot("opr")[0].until, 210)
  assert.equal(store.values.has(storageKey("project")), false, "a failed report is not acknowledged as durable")
  fail = false
  const recovered = await state.report({ ...report, ...paid })
  assert.ok(recovered.accepted)
  assert.deepEqual((await ModuleCooldowns.load(config(), store.storage, "project", () => 10)).snapshot("opr").map(c => c.modelID).sort(), [free.modelID, paid.modelID])
  await assert.rejects(ModuleCooldowns.load(config(), {
    get: async () => { throw new Error("synthetic read failure") },
    set: save,
  }, "project", () => 10), /synthetic read failure/)
})

test("module selection recommends free then paid then free with one evaluation time", async () => {
  let now = 10
  let clockReads = 0
  const state = await ModuleCooldowns.load(config(), memory().storage, "project", () => { clockReads++; return now })
  clockReads = 0
  assert.deepEqual(state.select("opr"), {
    module: "opr", evaluatedAt: 10, status: "selected", selected: { ...free, variant: "fast" },
    candidates: [
      { ...free, variant: "fast", reason: "declared", quota: "unknown", health: "unknown" },
      { ...paid, reason: "declared", quota: "unknown", health: "unknown" },
    ],
  })
  assert.equal(clockReads, 1)
  await state.report(report)
  const fallback = state.select("opr")
  if (fallback.status !== "selected") throw new Error("expected paid fallback")
  assert.deepEqual(fallback.selected, paid)
  assert.deepEqual(fallback.candidates[0], {
    ...free, variant: "fast", reason: "cooldown", blockedUntil: 210, remainingMs: 200, quota: "unknown", health: "unknown",
  })
  now = 210
  const recovered = state.select("opr")
  if (recovered.status !== "selected") throw new Error("expected free recovery")
  assert.deepEqual(recovered.selected, { ...free, variant: "fast" })
  assert.equal(recovered.candidates[0].reason, "declared")
  assert.equal("blockedUntil" in recovered.candidates[0], false)
})

test("all cooling returns the earliest eligibility deadline, not a provider reset", async () => {
  let now = 10
  const state = await ModuleCooldowns.load(config(), memory().storage, "project", () => now)
  await state.report(report)
  now = 30
  await state.report({ ...report, ...paid })
  const exhausted = state.select("opr")
  assert.equal(exhausted.status, "no-eligible")
  if (exhausted.status === "no-eligible") assert.equal(exhausted.nextEligibleAt, 130)
  assert.equal("selected" in exhausted, false)
  assert.deepEqual(exhausted.candidates.map(c => [c.reason, c.blockedUntil, c.remainingMs]), [
    ["cooldown", 210, 180], ["cooldown", 130, 100],
  ])
  now = 130
  const paidAgain = state.select("opr")
  if (paidAgain.status !== "selected") throw new Error("paid cooldown should have expired")
  assert.deepEqual(paidAgain.selected, paid)
  for (const module of ["missing", "toString", "__proto__"]) {
    assert.deepEqual(state.select(module), { module, evaluatedAt: 130, status: "no-module", candidates: [] })
  }
})

test("generic direct inventory never changes native registration or unknown-quota rules", async () => {
  const configured = parseConfig({ modules: {
    generic: { models: [{ id: "external/nested/decision", variant: "careful" }, "other/fallback"] },
  } })
  const original = structuredClone(configured)
  const store = memory()
  const state = await ModuleCooldowns.load(configured, store.storage, "project", () => 10)
  const first = state.select("generic")
  if (first.status !== "selected") throw new Error("declared direct model should be eligible")
  assert.deepEqual(first.selected, { providerID: "external", modelID: "nested/decision", variant: "careful" })
  assert.equal(first.candidates[0].quota, "unknown")
  assert.equal(first.candidates[0].health, "unknown")
  assert.equal(selectModel([first.selected], [], new Map(), 10).status, "no-eligible")
  const native = new Map([[modelKey(first.selected), { status: "unknown" as const }]])
  const nativeResult = selectModel([first.selected], [first.selected], native, 10)
  assert.equal(nativeResult.status, "no-eligible")
  assert.deepEqual(nativeResult.skipped[0].reason, { code: "unknown" })
  first.selected.modelID = "caller-mutated"
  first.candidates[0].modelID = "also-mutated"
  assert.deepEqual(configured, original)
  const second = state.select("generic")
  if (second.status !== "selected") throw new Error("query must not be sticky")
  assert.equal(second.selected.modelID, "nested/decision")
  assert.deepEqual(store.writes, [], "recommendations do not reserve models or persist selection")
})

test("failed pruning is retried before queries succeed and restart drops orphan metadata", async () => {
  const store = memory()
  const configured = config()
  const state = await ModuleCooldowns.load(configured, store.storage, "project", () => 10,
    async () => {})
  await state.report(report)
  const save = store.storage.set
  store.storage.set = async () => { throw new Error("prune failed") }
  delete configured.modules
  await assert.rejects(state.query("opr"), /prune failed/)
  configured.modules = config().modules
  await assert.rejects(state.query("opr"), /prune failed/)
  store.storage.set = save
  assert.equal((await state.query("opr")).status, "selected")
  assert.deepEqual((await ModuleCooldowns.load(config(), store.storage, "project", () => 10)).snapshot("opr"), [])
  await state.report(report)
  await ModuleCooldowns.load(parseConfig({}), store.storage, "project", () => 10)
  assert.deepEqual((await ModuleCooldowns.load(config(), store.storage, "project", () => 10)).snapshot("opr"), [], "startup without the profile durably removes its orphan deadline")
})


test("mapped module usage skips bad subscriptions and leaves Jev cooldown-only", async () => {
  const go = { providerID: "opencode-go", modelID: "deepseek" }
  const jev = { providerID: "opencode", modelID: "jev-free" }
  const cursor = { providerID: "cursor", modelID: "composer" }
  const exempt = { providerID: "openai", modelID: "codex-exempt" }
  const configured = parseConfig({
    usageSources: { "opencode-go": "go", cursor: "cursor", openai: "codex" },
    quotaExemptModels: ["openai/codex-exempt"],
    modules: {
      tracked: { cooldownMs: 100, models: ["opencode-go/deepseek", "opencode/jev-free", "cursor/composer"] },
      jev: { models: ["opencode/jev-free"] },
      exempt: { cooldownMs: 100, models: ["openai/codex-exempt"] },
      subs: { models: ["opencode-go/deepseek", "cursor/composer"] },
    },
  })
  const source = (availability: UsageSource["availability"], stale = false): UsageSource => ({
    authenticated: true, checkedAt: 1, stale, error: null, windows: [],
    nextAvailableAt: availability === "available" ? null : 1, availability,
  })
  const snap = (goSource: UsageSource, codex: UsageSource, cursorSource: UsageSource): UsageReadResult =>
    ({ status: "ok", snapshot: { updatedAt: 1, sources: { go: goSource, codex, cursor: cursorSource } } })
  let reads = 0
  let crash = false
  let current: UsageReadResult = snap(source("available"), source("limited"), source("limited"))
  const state = await ModuleCooldowns.load(configured, memory().storage, "project", () => 10, undefined, async () => {
    reads++
    if (crash) throw new Error("usage down")
    return current
  })
  const picked = await state.query("tracked")
  assert.equal(reads, 1)
  assert.equal(picked.status, "selected")
  if (picked.status === "selected") assert.deepEqual(picked.selected, go)
  assert.equal(picked.candidates[0].quota, "available")
  assert.equal(picked.candidates[0].health, "unknown")
  assert.deepEqual(picked.candidates.map(c => c.reason), ["declared", "declared", "limited"])
  current = snap({ ...source("limited"), windows: [{ name: "week", usedPercent: 100, state: "rate-limited", resetsAt: 1, resetEstimated: true }] }, source("available"), source("available", true))
  const fallback = await state.query("tracked")
  if (fallback.status === "selected") assert.deepEqual(fallback.selected, jev)
  assert.deepEqual(fallback.candidates.map(c => [c.reason, c.quota]), [["limited", "limited"], ["declared", "unknown"], ["usage-unavailable", "unknown"]])
  crash = true
  const failed = await state.query("tracked")
  crash = false
  if (failed.status === "selected") assert.deepEqual(failed.selected, jev)
  assert.equal(failed.candidates[0].reason, "usage-unavailable")
  const before = reads
  assert.equal((await state.query("jev")).candidates[0].quota, "unknown")
  assert.equal((await state.query("exempt")).status, "selected")
  assert.equal(reads, before, "Jev-only and exempt-only queries do not read usage")
  await state.report({ module: "exempt", ...exempt, reason: "rate-limit" })
  current = snap(source("available"), source("available"), source("available"))
  const cooled = await state.query("exempt")
  assert.equal(reads, before)
  assert.equal(cooled.status, "no-eligible")
  assert.equal(cooled.candidates[0].reason, "cooldown")
  if (cooled.status === "no-eligible") assert.equal(cooled.nextEligibleAt, 110)
  await state.report({ module: "tracked", ...go, reason: "temporary-unavailable" })
  const held = await state.query("tracked")
  assert.equal(held.candidates[0].reason, "cooldown")
  assert.equal(held.candidates[0].quota, "available")
  if (held.status === "selected") assert.deepEqual(held.selected, jev)
  if (held.status === "no-eligible") assert.equal(held.nextEligibleAt, 110)
  current = snap(source("limited"), source("available"), source("limited"))
  const exhausted = await state.query("subs")
  assert.equal(exhausted.status, "no-eligible")
  assert.equal("nextEligibleAt" in exhausted, false)
  const missing = snap(source("available"), source("available"), source("available"))
  if (missing.status === "ok") delete (missing.snapshot.sources as { go?: UsageSource }).go
  current = missing
  const skipped = await state.query("subs")
  if (skipped.status === "selected") assert.deepEqual(skipped.selected, cursor)
  assert.equal(skipped.candidates[0].reason, "usage-unavailable")
  const catalog = await state.selections()
  assert.equal(catalog.jev.candidates[0].quota, "unknown")
  assert.equal(catalog.tracked.candidates[0].reason, "cooldown")
  assert.equal(catalog.tracked.candidates[0].health, "unknown")
})
