import assert from "node:assert/strict"
import test from "node:test"
import type { CategoryDef, ModelRef } from "../src/config.ts"
import { orderCategory, orderCategoryByPace, orderCategoryByProtectedPace, orderCategoryByWeightedPace } from "../src/decision.ts"

const model = (providerID: string, modelID: string): ModelRef => ({ providerID, modelID })
const minute = 60_000
const now = 1_000 * minute

const category = (models: ModelRef[], pick?: CategoryDef["pick"]): CategoryDef =>
  (pick === undefined ? { models } : { models, pick })

const clock =
  (entries: Record<string, { resetsAt?: number; usedPercent?: number }>) =>
  (model: Pick<ModelRef, "providerID" | "modelID">) => entries[model.providerID]

test("reset-soonest puts the window that expires first at the front", () => {
  const fast = category(
    [model("far", "a"), model("soon", "b"), model("mid", "c")],
    { by: "reset-soonest" },
  )
  const ordered = orderCategory(fast, clock({
    far: { resetsAt: now + 300 * minute },
    soon: { resetsAt: now + 5 * minute },
    mid: { resetsAt: now + 60 * minute },
  }))
  assert.deepEqual(ordered.map((entry) => entry.providerID), ["soon", "mid", "far"])
})

test("a tie on reset prefers the window with more quota used", () => {
  const fast = category([model("low", "a"), model("high", "b")], { by: "reset-soonest" })
  const ordered = orderCategory(fast, clock({
    low: { resetsAt: now + minute, usedPercent: 12 },
    high: { resetsAt: now + minute, usedPercent: 88 },
  }))
  assert.deepEqual(ordered.map((entry) => entry.providerID), ["high", "low"])
})

test("a full tie follows the configured provider path, then the file's order", () => {
  const fast = category(
    [model("unlisted", "a"), model("second", "b"), model("first", "c"), model("first", "d")],
    { by: "reset-soonest", path: ["first", "second"] },
  )
  const ordered = orderCategory(fast, clock({
    unlisted: { resetsAt: now + minute },
    second: { resetsAt: now + minute },
    first: { resetsAt: now + minute },
  }))
  assert.deepEqual(ordered.map((entry) => `${entry.providerID}/${entry.modelID}`),
    ["first/c", "first/d", "second/b", "unlisted/a"])
})

test("providers without a clock sort last and as-listed ignores the clock", () => {
  const models = [model("unknown", "a"), model("known", "b")]
  const ordered = orderCategory(category(models, { by: "reset-soonest" }), clock({ known: { resetsAt: now + minute } }))
  assert.deepEqual(ordered.map((entry) => entry.providerID), ["known", "unknown"])
  assert.deepEqual(orderCategory(category(models), clock({ known: { resetsAt: now } })), models)
})

const pace =
  (entries: Record<string, number | undefined>) =>
  (model: Pick<ModelRef, "providerID" | "modelID">) => entries[model.providerID]

test("pace puts the provider with the most sustainable room per minute first", () => {
  const balanced = category(
    [model("tight", "a"), model("roomy", "b"), model("idle", "c")],
    { by: "pace" },
  )
  const ordered = orderCategoryByPace(balanced, pace({ tight: 0.01, roomy: 0.4, idle: 2 }))
  assert.deepEqual(ordered.map((entry) => entry.providerID), ["idle", "roomy", "tight"])
})

test("pace sorts a provider without a clock last and ties by path then file order", () => {
  const balanced = category(
    [model("unknown", "a"), model("second", "b"), model("first", "c"), model("first", "d")],
    { by: "pace", path: ["first", "second"] },
  )
  const ordered = orderCategoryByPace(balanced, pace({ second: 0.2, first: 0.2 }))
  assert.deepEqual(ordered.map((entry) => `${entry.providerID}/${entry.modelID}`),
    ["first/c", "first/d", "second/b", "unknown/a"])
  const models = [model("a", "x")]
  assert.deepEqual(orderCategoryByPace(category(models), pace({})), models)
  assert.deepEqual(orderCategoryByPace(category(models, { by: "reset-soonest" }), pace({ a: 1 })), models)
  // In order is the strategy for models sharing one bucket: the declared sequence survives.
  const shared = [model("a", "x"), model("a", "y")]
  assert.deepEqual(orderCategory(category(shared, { by: "in-order" }), clock({ known: { resetsAt: 1, usedPercent: 99 } })), shared)
  assert.deepEqual(orderCategoryByPace(category(shared, { by: "in-order" }), pace({ a: 9 })), shared)
})

test("weighted pace splits independent seeds in proportion to provider pace", () => {
  const weighted = category([model("slow", "a"), model("fast", "b")], { by: "weighted-pace" })
  const weights = pace({ slow: 1, fast: 3 })
  const seeds = 10_000
  let fast = 0
  for (let index = 0; index < seeds; index++) {
    const winner = orderCategoryByWeightedPace(weighted, weights, `session-${index}|agent|plan|42`)[0]
    if (winner.providerID === "fast") fast += 1
  }
  assert.ok(Math.abs(fast / seeds - 0.75) < 0.03, `expected about 75% on the 3x provider, saw ${fast / seeds}`)
})

test("weighted pace is deterministic and a provider races once, not once per model", () => {
  const duplicated = category(
    [model("a", "x"), model("b", "x"), model("a", "y")],
    { by: "weighted-pace" },
  )
  const weights = pace({ a: 1, b: 1 })
  const first = orderCategoryByWeightedPace(duplicated, weights, "seed")
  assert.deepEqual(first, orderCategoryByWeightedPace(duplicated, weights, "seed"))
  assert.deepEqual(first.filter((entry) => entry.providerID === "a").map((entry) => entry.modelID), ["x", "y"],
    "declared order stands inside one provider")

  const seeds = 10_000
  let a = 0
  for (let index = 0; index < seeds; index++) {
    const winner = orderCategoryByWeightedPace(duplicated, weights, `seed-${index}`)[0]
    if (winner.providerID === "a") a += 1
    if (winner.providerID === "a") assert.equal(winner.modelID, "x", "the provider's first declared model is its entry point")
  }
  // Two models on provider a must not double its 1:1 weight to 2:1.
  assert.ok(Math.abs(a / seeds - 0.5) < 0.03, `expected about 50% for provider a, saw ${a / seeds}`)
})

test("weighted pace ranks invalid weights last by path then file order", () => {
  const invalid = category(
    [model("zero", "a"), model("nan", "b"), model("missing", "c"), model("negative", "d"), model("fine", "e")],
    { by: "weighted-pace", path: ["missing", "nan"] },
  )
  const ordered = orderCategoryByWeightedPace(
    invalid,
    pace({ zero: 0, nan: Number.NaN, negative: -2, fine: 4 }),
    "seed",
  )
  assert.deepEqual(ordered.map((entry) => entry.providerID), ["fine", "missing", "nan", "zero", "negative"])
  const models = [model("a", "x")]
  assert.deepEqual(orderCategoryByWeightedPace(category(models), pace({ a: 1 }), "seed"), models)
  assert.deepEqual(orderCategoryByWeightedPace(category(models, { by: "pace" }), pace({ a: 1 }), "seed"), models)
})

test("window protection keeps the pace ranking and only claims its own strategy", () => {
  const protectedCategory = category(
    [model("risky", "a"), model("safe", "b")],
    { by: "window-protection", path: ["safe"] },
  )
  assert.deepEqual(
    orderCategoryByProtectedPace(protectedCategory, pace({ risky: 0.12, safe: 0.3 })).map((entry) => entry.providerID),
    ["safe", "risky"],
  )
  assert.deepEqual(
    orderCategoryByProtectedPace(category(protectedCategory.models, { by: "pace" }), pace({})),
    protectedCategory.models,
  )
})
