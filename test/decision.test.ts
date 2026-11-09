import assert from "node:assert/strict"
import test from "node:test"
import type { CategoryDef, ModelRef } from "../src/config.ts"
import { orderCategory, orderCategoryByPace } from "../src/decision.ts"

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
})
