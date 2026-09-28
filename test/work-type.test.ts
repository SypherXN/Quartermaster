import assert from "node:assert/strict"
import test from "node:test"
import { parseConfig } from "../src/config.ts"
import { modelKey, resolvePlan, selectModel } from "../src/select.ts"
import type { ModelRef } from "../src/config.ts"

const config = parseConfig({
  plans: {
    review: ["provider/review-model"],
    fast: ["provider/fast-model"],
  },
  agents: { reviewer: "review" },
  workTypes: { review: "review", quick: "fast" },
})
const registry: ModelRef[] = Object.values(config.plans).flat()
const eligibility = new Map(registry.map((model) => [modelKey(model), { status: "available" as const }]))

test("explicit work types select distinct plans for the same agent", () => {
  const review = resolvePlan(config, "reviewer", { workType: "review" })
  const quick = resolvePlan(config, "reviewer", { workType: "quick" })

  assert.equal(review.status, "plan")
  assert.equal(quick.status, "plan")
  if (review.status !== "plan" || quick.status !== "plan") return
  assert.equal(review.source, "work-type")
  assert.equal(quick.source, "work-type")
  const reviewSelection = selectModel(review.plan, registry, eligibility, 0)
  assert.equal(reviewSelection.status, "selected")
  if (reviewSelection.status === "selected") assert.equal(reviewSelection.model.modelID, "review-model")
  const selected = selectModel(quick.plan, registry, eligibility, 0)
  assert.equal(selected.status, "selected")
  if (selected.status === "selected") assert.equal(selected.model.modelID, "fast-model")
})

test("agent-only resolution keeps existing binding behavior", () => {
  assert.deepEqual(resolvePlan(config, "reviewer"), {
    status: "plan",
    planID: "review",
    plan: config.plans.review,
    source: "agent",
    reason: { code: "agent-binding" },
  })
  assert.deepEqual(resolvePlan(config, "unbound"), {
    status: "no-plan",
    reason: { code: "unbound-agent" },
  })
})

test("unknown work types fall back to the agent binding with an explanation", () => {
  assert.deepEqual(resolvePlan(config, "reviewer", { workType: "typo" }), {
    status: "plan",
    planID: "review",
    plan: config.plans.review,
    source: "agent",
    reason: { code: "unknown-work-type-agent-fallback", workType: "typo" },
  })
  assert.deepEqual(resolvePlan(config, "unbound", { workType: "typo" }), {
    status: "no-plan",
    reason: { code: "unknown-work-type", workType: "typo" },
  })
})

test("explicit user model takes precedence over work type and agent binding", () => {
  const explicitModel = { providerID: "custom", modelID: "user-choice" }
  assert.deepEqual(resolvePlan(config, "reviewer", { workType: "quick", explicitModel }), {
    status: "explicit-model",
    model: explicitModel,
    reason: { code: "explicit-user-model" },
  })
})
