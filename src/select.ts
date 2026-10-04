import type { ModelRef, QuartermasterConfig } from "./config.ts"

export type Availability = "available" | "limited" | "unknown"

export interface ModelEligibility {
  status: Availability
  staleAt?: number
  cooldownUntil?: number
  localOffline?: boolean
}

export type SkipReason =
  | "not-in-registry"
  | "status-missing"
  | "local-offline"
  | "unknown"
  | "stale"
  | "limited"
  | "cooldown"

export interface SkippedCandidate {
  model: ModelRef
  reason: { code: SkipReason }
}

export type SelectionResult =
  | {
      status: "selected"
      model: ModelRef
      reason: { code: "highest-priority-eligible" | "manual-pin" }
      skipped: SkippedCandidate[]
    }
  | { status: "no-plan"; reason: { code: "no-plan" }; skipped: [] }
  | { status: "no-eligible"; reason: { code: "no-eligible" }; skipped: SkippedCandidate[] }

export type PlanResolution =
  | { status: "explicit-model"; model: ModelRef; reason: { code: "explicit-user-model" } }
  | {
      status: "plan"
      planID: string
      plan: readonly ModelRef[]
      source: "work-type" | "agent"
      reason: { code: "work-type-binding" | "agent-binding" | "unknown-work-type-agent-fallback"; workType?: string }
    }
  | {
      status: "no-plan"
      reason: { code: "unbound-agent" | "unknown-work-type"; workType?: string }
    }

export function resolvePlan(
  config: Pick<QuartermasterConfig, "plans" | "agents" | "workTypes">,
  agentID: string,
  options: { workType?: string; explicitModel?: ModelRef } = {},
): PlanResolution {
  if (options.explicitModel) {
    return { status: "explicit-model", model: options.explicitModel, reason: { code: "explicit-user-model" } }
  }

  if (options.workType !== undefined) {
    const planID = Object.hasOwn(config.workTypes, options.workType) ? config.workTypes[options.workType] : undefined
    if (planID !== undefined) {
      return {
        status: "plan",
        planID,
        plan: config.plans[planID],
        source: "work-type",
        reason: { code: "work-type-binding" },
      }
    }

    const agentPlanID = Object.hasOwn(config.agents, agentID) ? config.agents[agentID] : undefined
    if (agentPlanID !== undefined) {
      return {
        status: "plan",
        planID: agentPlanID,
        plan: config.plans[agentPlanID],
        source: "agent",
        reason: { code: "unknown-work-type-agent-fallback", workType: options.workType },
      }
    }

    return { status: "no-plan", reason: { code: "unknown-work-type", workType: options.workType } }
  }

  const planID = Object.hasOwn(config.agents, agentID) ? config.agents[agentID] : undefined
  if (planID === undefined) return { status: "no-plan", reason: { code: "unbound-agent" } }
  return {
    status: "plan",
    planID,
    plan: config.plans[planID],
    source: "agent",
    reason: { code: "agent-binding" },
  }
}

export function modelKey(model: Pick<ModelRef, "providerID" | "modelID">): string {
  return JSON.stringify([model.providerID, model.modelID])
}

export function selectModel(
  plan: readonly ModelRef[] | undefined,
  registry: readonly ModelRef[],
  eligibility: ReadonlyMap<string, ModelEligibility>,
  now: number,
): SelectionResult {
  if (!plan) return { status: "no-plan", reason: { code: "no-plan" }, skipped: [] }

  const registered = new Set(registry.map(modelKey))
  const skipped: SkippedCandidate[] = []

  for (const model of plan) {
    const key = modelKey(model)
    const status = eligibility.get(key)
    const reason: SkipReason | undefined = !registered.has(key)
      ? "not-in-registry"
      : status === undefined
        ? "status-missing"
        : status.localOffline
          ? "local-offline"
        : status.cooldownUntil !== undefined && now < status.cooldownUntil
          ? "cooldown"
          : status.staleAt !== undefined && now >= status.staleAt
          ? "stale"
          : status.status === "available"
            ? undefined
            : status.status

    if (reason) {
      skipped.push({ model, reason: { code: reason } })
      continue
    }

    return {
      status: "selected",
      model,
      reason: { code: "highest-priority-eligible" },
      skipped,
    }
  }

  return { status: "no-eligible", reason: { code: "no-eligible" }, skipped }
}

export function selectAgentModel(
  config: Pick<QuartermasterConfig, "plans" | "agents">,
  agentID: string,
  registry: readonly ModelRef[],
  eligibility: ReadonlyMap<string, ModelEligibility>,
  now: number,
  pin?: ModelRef,
): SelectionResult {
  const planID = Object.hasOwn(config.agents, agentID) ? config.agents[agentID] : undefined
  const plan = planID === undefined ? undefined : config.plans[planID]
  if (!plan) return { status: "no-plan", reason: { code: "no-plan" }, skipped: [] }

  const candidates = pin
    ? [pin, ...plan.filter((candidate) => modelKey(candidate) !== modelKey(pin))]
    : plan
  const selection = selectModel(candidates, registry, eligibility, now)
  if (selection.status !== "selected" || !pin || modelKey(selection.model) !== modelKey(pin)) return selection
  return { ...selection, reason: { code: "manual-pin" } }
}
