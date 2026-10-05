import type { Agent } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ModelRef, QuartermasterConfig } from "./config.ts"
import { buildQuotaEligibility } from "./eligibility.ts"
import { FailureCooldowns, type FailureReport, type SuccessReport } from "./failures.ts"
import { applyLocalHealth, LocalHealth } from "./local-health.ts"
import { bindExclusive, ExclusiveLeases } from "./exclusive.ts"
import { explainSelection, type SelectionExplanation } from "./explain.ts"
import { AgentPins } from "./pins.ts"
import { adoptProjectQuartermasterOptions } from "./project-options.ts"
import { modelKey, resolvePlan, selectAgentModel, selectModel, type ModelEligibility } from "./select.ts"
import { readUsageStatus, type UsageReadResult, type UsageSourceID } from "./usage.ts"
import type { TokenBudgetGate, TokenBudgetReason } from "./telemetry/budget-gate.ts"

const COOLDOWN_STORAGE_KEY = "availability/cooldowns-v1"
const AVAILABILITY_REFRESH_MS = 60_000
const AGENT_RELOAD_DEBOUNCE_MS = 25

type AgentModel = NonNullable<Agent.Info["model"]>
type MutableAgentEditor = Pick<AgentEditor, "get" | "update">

function modelRef(model: { providerID: string; id: string }): ModelRef {
  return { providerID: model.providerID, modelID: model.id }
}

export function applyAgentRouting(
  editor: MutableAgentEditor,
  config: QuartermasterConfig,
  registry: readonly ModelRef[],
  eligibility: ReadonlyMap<string, ModelEligibility>,
  now: number,
  pins: ReadonlyMap<string, ModelRef> = new Map(),
  budgetReasons: readonly TokenBudgetReason[] = [],
  onBudgetWarning?: (agentID: string, selection: ReturnType<typeof selectAgentModel>, reasons: readonly TokenBudgetReason[]) => void,
  exclusive?: { blocks(agentID: string, model: ModelRef): boolean },
): void {
  for (const agentID of Object.keys(config.agents)) {
    if (!editor.get(agentID)) continue

    const selection = selectAgentModel(
      config,
      agentID,
      registry,
      eligibility,
      now,
      pins.get(agentID),
      exclusive && ((model) => exclusive.blocks(agentID, model)),
    )
    if (budgetReasons.length > 0) onBudgetWarning?.(agentID, selection, budgetReasons)
    if (selection.status !== "selected") continue

    editor.update(agentID, (agent) => {
      agent.model = {
        providerID: selection.model.providerID as AgentModel["providerID"],
        id: selection.model.modelID as AgentModel["id"],
        ...(selection.model.variant === undefined
          ? {}
          : { variant: selection.model.variant as NonNullable<AgentModel["variant"]> }),
      }
    })
  }
}

export async function registerAgentRouting(
  ctx: Pick<Context, "agent" | "model" | "rpc" | "storage"> & Partial<Pick<Context, "session" | "event">> & { location?: { directory?: string } },
  config: QuartermasterConfig,
  usage?: UsageReadResult,
  budgetGate?: TokenBudgetGate,
) {
  if (
    config.exclusiveModels.length === 0 &&
    Object.keys(config.agents).length === 0 &&
    Object.keys(config.workTypes).length === 0
  ) return undefined

  let registry = (await ctx.model.list()).data.filter((model) => model.enabled).map(modelRef)
  const localHealth = new LocalHealth(config.localEndpoints, config.localHealthTimeoutMs)
  let health = await localHealth.checkAll(registry.map((model) => model.providerID))
  let quotaEligibility = buildQuotaEligibility(registry, config.usageSources, config.quotaExemptModels, usage)
  let eligibility = applyLocalHealth(registry, quotaEligibility, health)
  const failures = new FailureCooldowns(config.providerCooldownMs)
  failures.restore(await ctx.storage.get(COOLDOWN_STORAGE_KEY), Date.now())
  eligibility = failures.apply(eligibility, registry, Date.now())
  const pins = await AgentPins.load(config, registry, ctx.storage)
  const leases = new ExclusiveLeases()
  const busyFor = (agentID: string) => (model: ModelRef) => leases.blocks(agentID, model)
  const selectedFor = (agentID: string) => selectAgentModel(
    config,
    agentID,
    registry,
    failures.apply(baseSnapshot(), registry, Date.now()),
    Date.now(),
    pins.get(agentID),
    busyFor(agentID),
  )
  const registration = Object.keys(config.agents).length > 0
      ? await ctx.agent.transform((editor) => {
        const now = Date.now()
        applyAgentRouting(
          editor,
          config,
          registry,
          failures.apply(eligibility, registry, now),
          now,
          pins.snapshot(),
          budgetGate?.reasons(now),
          (agentID, selection, reasons) => console.warn("[quartermaster] token budget advisory", JSON.stringify({ agentID, selection, reasons })),
          leases,
        )
      })
    : undefined
  if (registration) {
    try {
      await ctx.agent.reload()
    } catch (error) {
      await registration.dispose()
      throw error
    }
  }

  let reloadTimer: ReturnType<typeof setTimeout> | undefined
  let reloadPromise: Promise<void> | undefined
  let refreshPromise: Promise<boolean> | undefined
  let injectedEligibility: ReadonlyMap<string, ModelEligibility> | undefined
  let persistence = Promise.resolve()

  const fingerprint = (map: ReadonlyMap<string, ModelEligibility>) =>
    JSON.stringify([...map].sort(([a], [b]) => a.localeCompare(b)))

  const baseSnapshot = () => injectedEligibility ?? applyLocalHealth(registry, quotaEligibility, health)

  const applyCurrent = async () => {
    const before = fingerprint(eligibility)
    eligibility = failures.apply(baseSnapshot(), registry, Date.now())
    const changed = before !== fingerprint(eligibility)
    if (changed) await requestReload()
    return changed
  }

  const persistCooldowns = () => {
    const state = JSON.parse(JSON.stringify({ cooldowns: failures.snapshot(Date.now()) }))
    persistence = persistence.catch(() => {}).then(() => ctx.storage.set(COOLDOWN_STORAGE_KEY, state))
    return persistence
  }

  const requestReload = () => {
    if (!registration) return Promise.resolve()
    if (reloadPromise) return reloadPromise
    reloadPromise = new Promise<void>((resolve, reject) => {
      reloadTimer = setTimeout(() => {
        reloadTimer = undefined
        void ctx.agent.reload().then(resolve, reject).finally(() => {
          reloadPromise = undefined
        })
      }, AGENT_RELOAD_DEBOUNCE_MS)
    })
    return reloadPromise
  }

  const refresh = (nextEligibility?: ReadonlyMap<string, ModelEligibility>): Promise<boolean> => {
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
      const before = fingerprint(eligibility)
      registry = (await ctx.model.list()).data.filter((model) => model.enabled).map(modelRef)
      pins.setRegistry(registry)
      if (nextEligibility !== undefined) {
        injectedEligibility = nextEligibility
      } else {
        injectedEligibility = undefined
        if (Object.keys(config.usageSources).length > 0) usage = await readUsageStatus(ctx)
        health = await localHealth.checkAll(registry.map((model) => model.providerID), { force: true })
        quotaEligibility = buildQuotaEligibility(registry, config.usageSources, config.quotaExemptModels, usage)
      }
      eligibility = failures.apply(baseSnapshot(), registry, Date.now())
      const changed = before !== fingerprint(eligibility)
      if (changed) await requestReload()
      return changed
    })().finally(() => {
      refreshPromise = undefined
    })
    return refreshPromise
  }

  const interval = setInterval(() => {
    void refresh().catch(() => console.warn("[quartermaster] availability refresh failed"))
  }, AVAILABILITY_REFRESH_MS)
  interval.unref?.()
  const exclusiveGate = await bindExclusive(ctx, leases, config.exclusiveModels, async (changed) => {
    if (changed) await requestReload()
  })

  const ensureProjectOptions = async () => {
    if (ctx.location?.directory) await adoptProjectQuartermasterOptions(config, ctx.location.directory).catch(() => undefined)
  }

  const select = async (agentID: string, workType?: string) => {
    await ensureProjectOptions()
    const resolution = resolvePlan(config, agentID, { workType })
    if (resolution.status === "explicit-model") {
      return { status: "explicit-model", model: resolution.model, reasonCode: resolution.reason.code }
    }
    if (resolution.status === "no-plan") {
      const explanation = explainSelection({ status: "no-plan", reason: { code: "no-plan" }, skipped: [] })
      return {
        ...explanation,
        reasonCode: resolution.reason.code,
        reason: resolution.reason.code === "unknown-work-type" ? "Unknown work type and no agent plan is configured." : "No model plan is configured for this agent.",
      }
    }
    const currentRegistry = (await ctx.model.list()).data.filter((model) => model.enabled).map(modelRef)
    const currentHealth = await localHealth.checkAll(currentRegistry.map((model) => model.providerID))
    const base = applyLocalHealth(currentRegistry, buildQuotaEligibility(currentRegistry, config.usageSources, config.quotaExemptModels, usage), currentHealth)
    const currentEligibility = failures.apply(base, currentRegistry, Date.now())
    const pin = pins.get(agentID)
    const candidates = pin ? [pin, ...resolution.plan.filter((candidate) => modelKey(candidate) !== modelKey(pin))] : resolution.plan
    let selection = selectModel(candidates, currentRegistry, currentEligibility, Date.now(), busyFor(agentID))
    if (selection.status === "selected" && pin && modelKey(selection.model) === modelKey(pin)) selection = { ...selection, reason: { code: "manual-pin" } }
    return { ...explainSelection(selection), plan: { id: resolution.planID, source: resolution.source, reasonCode: resolution.reason.code } }
  }

  const plans = () => ({ plans: config.plans, agents: config.agents, workTypes: config.workTypes })
  const status = async () => {
    await ensureProjectOptions()
    const currentPlans = plans()
    const currentUsage = usage
    if (!currentUsage) return { apiVersion: 1, ...currentPlans, status: Object.keys(config.usageSources).length > 0 ? "unavailable" : "unconfigured", ...(Object.keys(config.usageSources).length > 0 ? { reason: "not-read" } : {}), sources: {} }
    if (currentUsage.status === "unavailable") return { apiVersion: 1, ...currentPlans, status: "unavailable", reason: currentUsage.reason, sources: {} }
    return {
      apiVersion: 1,
      ...currentPlans,
      status: "ok",
      updatedAt: currentUsage.snapshot.updatedAt,
      sources: Object.fromEntries(Object.entries(config.usageSources).map(([providerID, sourceID]) => {
        const source = currentUsage.snapshot.sources[sourceID as UsageSourceID]
        return [providerID, { sourceID, authenticated: source.authenticated, checkedAt: source.checkedAt, stale: source.stale, availability: source.availability, nextAvailableAt: source.nextAvailableAt, windows: source.windows.map(({ name, usedPercent, state, resetsAt, resetEstimated }) => ({ name, usedPercent, state, resetsAt, ...(resetEstimated === undefined ? {} : { resetEstimated }) })) }]
      })),
    }
  }

  return {
    async reportFailure(report: FailureReport) {
      if (!failures.reportFailure(report, Date.now())) return false
      await persistCooldowns()
      return applyCurrent()
    },
    async reportSuccess(report: SuccessReport) {
      if (!failures.reportSuccess(report)) return false
      await persistCooldowns()
      return applyCurrent()
    },
    async pin(agentID: string, model: unknown): Promise<ModelRef> {
      const pinned = await pins.pin(agentID, model)
      await requestReload()
      return pinned
    },
    async unpin(agentID: string): Promise<boolean> {
      const changed = await pins.unpin(agentID)
      if (changed) await requestReload()
      return changed
    },
    async explain(agentID: string): Promise<SelectionExplanation> {
      await ensureProjectOptions()
      return explainSelection(selectedFor(agentID))
    },
    select,
    status,
    refresh,
    async refreshBudgets() {
      await requestReload()
    },
    async dispose() {
      clearInterval(interval)
      await exclusiveGate.dispose()
      if (refreshPromise) await refreshPromise.catch(() => {})
      if (reloadPromise) await reloadPromise
      await registration?.dispose()
    },
  }
}
