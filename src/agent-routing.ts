import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import type { Agent } from "@opencode/plugin"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ModelRef, QuartermasterConfig } from "./config.ts"
import { buildQuotaEligibility } from "./eligibility.ts"
import { classifyRetryFailure, FailureCooldowns, type FailureReport, type SuccessReport } from "./failures.ts"
import { applyLocalHealth, LocalHealth } from "./local-health.ts"
import { bindExclusive, ExclusiveLeases } from "./exclusive.ts"
import { explainSelection, type SelectionExplanation } from "./explain.ts"
import { AgentPins } from "./pins.ts"
import { adoptProjectQuartermasterOptions, readNativeConfiguration, type ConfigurationReader } from "./project-options.ts"
import { modelKey, resolvePlan, selectAgentModel, selectModel, type ModelEligibility } from "./select.ts"
import { readUsageStatus, type UsageReadResult, type UsageSourceID } from "./usage.ts"
import type { TokenBudgetGate, TokenBudgetReason } from "./telemetry/budget-gate.ts"

const COOLDOWN_STORAGE_KEY = "availability/cooldowns-v1"
const AVAILABILITY_REFRESH_MS = 60_000
const AGENT_RELOAD_DEBOUNCE_MS = 25
const PLUGIN_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version

type AgentModel = NonNullable<Agent.Info["model"]>
type MutableAgentEditor = Pick<AgentEditor, "get" | "update">

function modelRef(model: { providerID: string; id: string; variant?: string }): ModelRef {
  return {
    providerID: model.providerID,
    modelID: model.id,
    ...(model.variant === undefined ? {} : { variant: model.variant }),
  }
}

interface SessionModel {
  providerID: string
  id: string
  variant?: string
}

function sessionView(value: unknown): { agent?: string; model?: SessionModel; projectID?: string } {
  const record = value && typeof value === "object" && "data" in value && typeof (value as { data?: unknown }).data === "object"
    ? (value as { data: unknown }).data
    : value
  if (!record || typeof record !== "object") return {}
  const info = record as { agent?: unknown; model?: unknown; projectID?: unknown }
  const agent = typeof info.agent === "string" && info.agent ? info.agent : undefined
  const raw = info.model && typeof info.model === "object" ? info.model as { providerID?: unknown; id?: unknown; variant?: string } : undefined
  const model = raw && typeof raw.providerID === "string" && typeof raw.id === "string"
    ? { providerID: raw.providerID, id: raw.id, ...(typeof raw.variant === "string" ? { variant: raw.variant } : {}) }
    : undefined
  return { ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(typeof info.projectID === "string" ? { projectID: info.projectID } : {}) }
}

function diagnosticRead<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([read, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Diagnostic read timed out")), 2_000)
  })]).finally(() => clearTimeout(timer))
}

function sameSessionModel(model: ModelRef, current?: SessionModel) {
  return current?.providerID === model.providerID && current.id === model.modelID && (current.variant ?? "default") === (model.variant ?? "default")
}

function sameModelRef(left: ModelRef, right: ModelRef) {
  return modelKey(left) === modelKey(right) && (left.variant ?? "default") === (right.variant ?? "default")
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
  ctx: Pick<Context, "agent" | "model" | "rpc" | "storage"> & Partial<Pick<Context, "session" | "event" | "command" | "app">> & {
    location?: { directory?: string; project?: { id?: string } }
  },
  config: QuartermasterConfig,
  usage?: UsageReadResult,
  budgetGate?: TokenBudgetGate,
  readConfiguration: ConfigurationReader = readNativeConfiguration,
) {
  if (
    config.exclusiveModels.length === 0 &&
    Object.keys(config.agents).length === 0 &&
    Object.keys(config.workTypes).length === 0 &&
    !(ctx.command && ctx.session)
  ) return undefined

  let registry = (await ctx.model.list()).data.filter((model) => model.enabled).map(modelRef)
  let localHealth = new LocalHealth(config.localEndpoints, config.localHealthTimeoutMs)
  let localHealthOptions = JSON.stringify([config.localEndpoints, config.localHealthTimeoutMs])
  let health = await localHealth.checkAll(registry.map((model) => model.providerID))
  let availabilityCheckedAt = Date.now()
  const instanceID = randomUUID()
  let quotaEligibility = buildQuotaEligibility(registry, config.usageSources, config.quotaExemptModels, usage)
  let eligibility = applyLocalHealth(registry, quotaEligibility, health)
  const failures = new FailureCooldowns(config.providerCooldownMs)
  failures.restore(await ctx.storage.get(COOLDOWN_STORAGE_KEY), Date.now())
  eligibility = failures.apply(eligibility, registry, Date.now())
  const pins = await AgentPins.load(config, registry, ctx.storage, ctx.location?.project?.id)
  const leases = new ExclusiveLeases()
  const busyFor = (sessionID?: string) => (model: ModelRef) =>
    sessionID === undefined ? leases.taken(model) : leases.blocks(sessionID, model)
  const selectedFor = (agentID: string, sessionID?: string) => selectAgentModel(
    config,
    agentID,
    registry,
    failures.apply(baseSnapshot(), registry, Date.now()),
    Date.now(),
    pins.get(agentID),
    busyFor(sessionID),
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

  const refresh = (nextEligibility?: ReadonlyMap<string, ModelEligibility>, refreshAvailability = true): Promise<boolean> => {
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
      const before = fingerprint(eligibility)
      const nextRegistry = (await ctx.model.list()).data.filter((model) => model.enabled).map(modelRef)
      const registryChanged = registry.length !== nextRegistry.length || registry.some((model) =>
        !nextRegistry.some((candidate) => sameModelRef(model, candidate)),
      )
      registry = nextRegistry
      await pins.setRegistry(registry)
      if (nextEligibility !== undefined) {
        injectedEligibility = nextEligibility
      } else {
        if (refreshAvailability || registryChanged) {
          injectedEligibility = undefined
          if (Object.keys(config.usageSources).length > 0) usage = await readUsageStatus(ctx)
          health = await localHealth.checkAll(registry.map((model) => model.providerID))
          quotaEligibility = buildQuotaEligibility(registry, config.usageSources, config.quotaExemptModels, usage)
        }
      }
      eligibility = failures.apply(baseSnapshot(), registry, Date.now())
      availabilityCheckedAt = Date.now()
      const changed = registryChanged || before !== fingerprint(eligibility)
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
  const running = new Set<string>()
  let promptHook: { dispose: () => Promise<void> } | undefined
  let runningHook: { dispose: () => Promise<void> } | undefined
  let retryHook: { dispose: () => Promise<void> } | undefined
  const requestKinds = new Map<string, { kind: string; agent: string; model: ModelRef }>()
  const attemptedModels = new Map<string, Set<string>>()
  const lastPrimaryModels = new Map<string, { agent: string; model: ModelRef }>()
  const ownershipScope = encodeURIComponent(ctx.location?.project?.id ?? ctx.location?.directory ?? "runtime")
  const ownershipKey = (sessionID: string) => `routing/ownership-v1/${ownershipScope}/${encodeURIComponent(sessionID)}`
  const clearOwnership = async (sessionID: string) => {
    try {
      await ctx.storage.remove(ownershipKey(sessionID))
    } catch {
      console.warn("[quartermaster] session ownership cleanup failed")
    }
  }
  const commandRegistration = ctx.command && ctx.session
    ? await ctx.command.transform((editor) => {
      editor.add({
        name: "qm-auto",
        description: "Let Quartermaster route this session's bound agent",
        execute: async ({ sessionID }) => {
          const view = sessionView(await ctx.session!.get({ sessionID } as never))
          if (!view.agent || !Object.hasOwn(config.agents, view.agent) || !config.plans[config.agents[view.agent] ?? ""]) {
            throw new Error("Quartermaster automatic routing requires a bound agent with a configured plan")
          }
          await ctx.storage.set(ownershipKey(sessionID), { mode: "automatic", agent: view.agent })
        },
      })
      editor.add({
        name: "qm-manual",
        description: "Keep this session under the host's model selection",
        execute: async ({ sessionID }) => {
          const view = sessionView(await ctx.session!.get({ sessionID } as never))
          await ctx.storage.set(ownershipKey(sessionID), { mode: "manual", ...(view.agent ? { agent: view.agent } : {}) })
          leases.releaseReservation(sessionID)
        },
      })
      editor.add({
        name: "qm-status",
        description: "Queue read-only Quartermaster diagnostics for a later turn; diagnoseSession RPC returns immediately",
        execute: async ({ sessionID }) => {
          const report = await diagnoseSession(sessionID)
          await ctx.session!.synthetic({
            sessionID,
            text: JSON.stringify(report, null, 2),
            description: "Quartermaster routing diagnostics (not provider-send proof)",
            delivery: "queue",
            resume: false,
          })
        },
      })
    })
    : undefined
  const exclusiveKeys = new Set(config.exclusiveModels.map((model) => modelKey(model)))

  const ensureProjectOptions = async () => {
    if (ctx.location?.directory) {
      await adoptProjectQuartermasterOptions(config, ctx.location.directory, readConfiguration).catch(() => undefined)
      const nextHealthOptions = JSON.stringify([config.localEndpoints, config.localHealthTimeoutMs])
      if (nextHealthOptions !== localHealthOptions) {
        localHealthOptions = nextHealthOptions
        localHealth = new LocalHealth(config.localEndpoints, config.localHealthTimeoutMs)
      }
      failures.setDuration(config.providerCooldownMs)
    }
    await pins.revalidate()
  }

  const choose = (agentID: string, sessionID: string) => selectAgentModel(
    config,
    agentID,
    registry,
    failures.apply(baseSnapshot(), registry, Date.now()),
    Date.now(),
    pins.get(agentID),
    busyFor(sessionID),
  )

  const diagnoseSession = async (sessionID: string) => {
    let view: ReturnType<typeof sessionView> = {}
    let sessionRead: "ok" | "unavailable" = "ok"
    let ownership: { mode?: unknown; agent?: unknown } | undefined
    let ownershipRead: "ok" | "unavailable" = "ok"
    try {
      view = sessionView(await diagnosticRead(ctx.session!.get({ sessionID } as never, { signal: AbortSignal.timeout(2_000) })))
    } catch {
      sessionRead = "unavailable"
    }
    try {
      ownership = await diagnosticRead(ctx.storage.get(ownershipKey(sessionID))) as typeof ownership
    } catch {
      ownershipRead = "unavailable"
    }
    const projectID = ctx.location?.project?.id
    const scope = projectID && view.projectID ? (projectID === view.projectID ? "confirmed-project" : "mismatch") : "unknown"
    if (scope === "mismatch") view = {}
    const now = Date.now()
    const agentID = view.agent
    const bound = agentID !== undefined && Object.hasOwn(config.agents, agentID)
    const planID = bound ? config.agents[agentID] : undefined
    const plan = planID === undefined ? undefined : config.plans[planID]
    const mode = !agentID ? "unknown" : !bound ? "unbound" : ownershipRead !== "ok" ? "unknown"
      : ownership?.agent === agentID && ownership.mode === "manual" ? "manual" : "automatic"
    // Snapshot-only: refresh/select/status can adopt options, persist pins or reload agents.
    const recommendation = explainSelection(selectAgentModel(
      config, agentID ?? "", registry, failures.apply(baseSnapshot(), registry, now), now,
      agentID ? pins.get(agentID) : undefined,
      (model) => leases.peekBlocks(sessionID, model),
    ))
    const observed = lastPrimaryModels.get(sessionID)
    const quotaConfigured = Object.keys(config.usageSources).length > 0
    const currentUsage = usage
    return {
      apiVersion: 1,
      plugin: { id: "quartermaster", version: PLUGIN_VERSION },
      runtime: {
        processID: process.pid,
        pluginInstanceID: instanceID,
        host: ctx.app ? { name: ctx.app.name, version: ctx.app.version, channel: ctx.app.channel } : "unknown",
        verifiedAdmissionHost: "OpenCode 2.0.25 and 2.0.26 (isolated fixtures; not an OpenChamber support claim)",
        identityScope: "local handling process and plugin instance; session ID alone is not runtime identity",
      },
      location: { projectID: ctx.location?.project?.id ?? "unknown", directory: ctx.location?.directory ?? "unknown" },
      session: {
        id: sessionID, read: sessionRead, scope, agent: agentID ?? "unknown", mode, ownershipRead,
        model: view.model ? modelRef(view.model) : "unknown",
        binding: !agentID ? "unknown" : !bound ? "unbound" : !plan ? "missing-plan" : "configured",
        plan: planID === undefined ? null : { id: planID, candidates: plan ?? [] },
        activePrimary: scope === "mismatch" ? "unknown" : running.has(sessionID),
      },
      availability: {
        basis: "cached router snapshot; no refresh, polling or option adoption",
        snapshotReadAt: availabilityCheckedAt,
        snapshotAgeMs: Math.max(0, now - availabilityCheckedAt),
        periodicRefreshMs: AVAILABILITY_REFRESH_MS,
        localHealthCacheMs: 5_000,
        localHealth: Object.fromEntries(Object.keys(config.localEndpoints).map((provider) => [provider, health.get(provider) ?? "unknown"])),
        quota: !quotaConfigured ? "unconfigured" : currentUsage?.status ?? "unavailable",
        quotaUpdatedAt: quotaConfigured && currentUsage?.status === "ok" ? currentUsage.snapshot.updatedAt : null,
        sources: !quotaConfigured || currentUsage?.status !== "ok" ? {} : Object.fromEntries(Object.entries(config.usageSources).map(([provider, sourceID]) => {
          const source = currentUsage.snapshot.sources[sourceID as UsageSourceID]
          return [provider, { sourceID, checkedAt: source.checkedAt, stale: source.stale || source.checkedAt === null || now < source.checkedAt || now - source.checkedAt > 300_000, availability: source.availability }]
        })),
      },
      recommendation: { ...recommendation, applies: mode === "automatic", note: "Snapshot recommendation only; manual/unbound choices are not changed. Admission rechecks availability." },
      primaryRequestEvidence: {
        lastObserved: scope === "mismatch" ? "unknown" : observed ?? "unknown",
        basis: "model.request hook observed in this plugin instance; not proof of an HTTP send or successful inference",
      },
    }
  }

  const assignPrompt = async (sessionID: string) => {
    if (running.has(sessionID) || !ctx.session?.get || !ctx.session.switchModel) return
    await ensureProjectOptions()
    await refresh()
    let view: ReturnType<typeof sessionView>
    try {
      view = sessionView(await ctx.session.get({ sessionID } as never))
    } catch {
      leases.releaseReservation(sessionID)
      throw new Error("Quartermaster could not read session ownership before provider admission")
    }
    const agentID = view.agent
    if (!agentID) {
      leases.releaseReservation(sessionID)
      throw new Error("Quartermaster could not read session ownership before provider admission")
    }
    if (!Object.hasOwn(config.agents, agentID)) {
      await clearOwnership(sessionID)
      return
    }
    let ownership: { mode?: unknown; agent?: unknown } | undefined
    try {
      ownership = await ctx.storage.get(ownershipKey(sessionID)) as typeof ownership
    } catch {
      leases.releaseReservation(sessionID)
      throw new Error("Quartermaster could not read session ownership before provider admission")
    }
    if (ownership?.agent !== agentID) await clearOwnership(sessionID)
    if (ownership?.agent === agentID && ownership.mode === "manual") {
      leases.releaseReservation(sessionID)
      return
    }
    // Bound agents are automatic by default; /qm-manual is the per-session opt-out.
    let selection = choose(agentID, sessionID)
    if (selection.status !== "selected") {
      leases.releaseReservation(sessionID)
      throw new Error("Quartermaster could not select an eligible model before provider admission")
    }
    if (exclusiveKeys.has(modelKey(selection.model))) {
      leases.releaseReservation(sessionID)
      if (leases.reserve(selection.model, sessionID, agentID) === "busy") {
        selection = choose(agentID, sessionID)
        if (selection.status !== "selected" || exclusiveKeys.has(modelKey(selection.model))) {
          throw new Error("Quartermaster could not reserve an eligible model before provider admission")
        }
      }
    } else leases.releaseReservation(sessionID)
    if (selection.status !== "selected" || sameSessionModel(selection.model, view.model)) return
    try {
      await ctx.session.switchModel({
        sessionID,
        model: {
          providerID: selection.model.providerID,
          id: selection.model.modelID,
          ...(selection.model.variant === undefined ? {} : { variant: selection.model.variant }),
        },
      } as never)
      const selectedView = sessionView(await ctx.session.get({ sessionID } as never))
      if (!sameSessionModel(selection.model, selectedView.model)) {
        throw new Error("Quartermaster model switch was not reflected before provider admission")
      }
    } catch {
      console.warn("[quartermaster] session model selection failed")
      if (exclusiveKeys.has(modelKey(selection.model))) leases.releaseReservation(sessionID)
      throw new Error("Quartermaster could not confirm its model switch before provider admission")
    }
  }

  if (ctx.session && Object.keys(config.agents).length > 0) {
    runningHook = await ctx.session.hook("model.request", async (input) => {
      const model = modelRef(input.model)
      if (input.kind === "primary" && Object.hasOwn(config.agents, input.agent) && ctx.session?.get) {
        try {
          const ownership = await ctx.storage.get(ownershipKey(input.sessionID)) as { mode?: unknown; agent?: unknown } | undefined
          if (!(ownership?.agent === input.agent && ownership.mode === "manual")) {
            const view = sessionView(await ctx.session.get({ sessionID: input.sessionID } as never))
            if (view.agent !== input.agent || (ctx.location?.project?.id && view.projectID !== ctx.location.project.id)) {
              throw new Error("Quartermaster could not confirm request ownership before provider dispatch")
            }
            await ensureProjectOptions()
            await refresh()
            if (Object.hasOwn(config.agents, input.agent)) {
              const plan = config.plans[config.agents[input.agent] ?? ""]
              // ponytail: validate the captured model only; native dequeue selection needs a host hook.
              const valid = selectModel(plan?.filter((candidate) => modelKey(candidate) === modelKey(model)),
                registry, failures.apply(baseSnapshot(), registry, Date.now()), Date.now(), busyFor(input.sessionID))
              if (valid.status !== "selected") {
                throw new Error("Quartermaster blocked a stale or ineligible model before provider dispatch; send again when the session is idle")
              }
            }
          }
        } catch (error) {
          leases.releaseReservation(input.sessionID)
          throw error
        }
      }
      requestKinds.set(input.sessionID, { kind: input.kind, agent: input.agent, model })
      if (input.kind === "primary") {
        lastPrimaryModels.set(input.sessionID, { agent: input.agent, model })
        running.add(input.sessionID)
        const attempted = attemptedModels.get(input.sessionID) ?? new Set<string>()
        attempted.add(modelKey(model))
        attemptedModels.set(input.sessionID, attempted)
      }
    })
    retryHook = await ctx.session.hook("retry", async (event) => {
      const request = requestKinds.get(event.sessionID)
      if (
        request?.kind !== "primary" ||
        request.agent !== event.agent || modelKey(request.model) !== modelKey(modelRef(event.model)) ||
        !ctx.session?.get || !ctx.session.switchModel
      ) return

      await ensureProjectOptions()
      let view: ReturnType<typeof sessionView>
      try {
        view = sessionView(await ctx.session.get({ sessionID: event.sessionID } as never))
      } catch {
        return
      }
      const agentID = view.agent
      const current = view.model
      if (!agentID || agentID !== event.agent || !Object.hasOwn(config.agents, agentID)) return
      const ownership = await ctx.storage.get(ownershipKey(event.sessionID)) as { mode?: unknown; agent?: unknown } | undefined
      if (ownership?.agent === agentID && ownership.mode === "manual") return
      const plan = config.plans[config.agents[agentID] ?? ""]
      if (!current || !plan?.some((candidate) => candidate.providerID === current.providerID && candidate.modelID === current.id)) return
      if (!sameSessionModel(modelRef(event.model), current)) return

      const failure = classifyRetryFailure(event.error, event.model.providerID, event.model.id)
      if (failure.report && failures.reportFailure(failure.report, Date.now())) {
        await persistCooldowns()
        await applyCurrent()
      }

      if (event.decision.retry !== true || !failure.fallback) return

      await refresh()

      const attempted = attemptedModels.get(event.sessionID) ?? new Set([modelKey(modelRef(event.model))])
      const retryPlan = plan?.filter((candidate) => !attempted.has(modelKey(candidate)))
      const retryPin = pins.get(agentID)
      const retryCandidates = retryPin && !attempted.has(modelKey(retryPin))
        ? [retryPin, ...(retryPlan ?? []).filter((candidate) => modelKey(candidate) !== modelKey(retryPin))]
        : retryPlan
      let selection = selectModel(
        retryCandidates,
        registry,
        failures.apply(baseSnapshot(), registry, Date.now()),
        Date.now(),
        busyFor(event.sessionID),
      )
      if (selection.status === "no-eligible" && selection.skipped.length > 0 && selection.skipped.every(({ reason }) => reason.code === "not-in-registry")) {
        await refresh()
        selection = selectModel(retryCandidates, registry, failures.apply(baseSnapshot(), registry, Date.now()), Date.now(), busyFor(event.sessionID))
      }
      if (selection.status !== "selected" || sameSessionModel(selection.model, current)) return
      const targetIsExclusive = exclusiveKeys.has(modelKey(selection.model))
      if (targetIsExclusive && leases.reserve(selection.model, event.sessionID, agentID) === "busy") return
      try {
        await ctx.session.switchModel({
          sessionID: event.sessionID,
          model: {
            providerID: selection.model.providerID,
            id: selection.model.modelID,
            ...(selection.model.variant === undefined ? {} : { variant: selection.model.variant }),
          },
        } as never)
        attempted.add(modelKey(selection.model))
        attemptedModels.set(event.sessionID, attempted)
        if (exclusiveKeys.has(modelKey(modelRef(current)))) leases.releaseModelReservation(modelRef(current), event.sessionID)
      } catch {
        console.warn("[quartermaster] retry model selection failed")
        attempted.add(modelKey(selection.model))
        attemptedModels.set(event.sessionID, attempted)
        if (targetIsExclusive) leases.releaseModelReservation(selection.model, event.sessionID)
      }
    })
    promptHook = await ctx.session.hook("prompt", async (input) => {
      await assignPrompt(input.sessionID)
    })
  }

  // Validate automatic ownership/availability before acquiring an exclusive request lease.
  const exclusiveGate = await bindExclusive(ctx, leases, config.exclusiveModels, async () => {}, async (step) => {
    if (step.kind === "finish" || step.kind === "delete") {
      running.delete(step.sessionID)
      requestKinds.delete(step.sessionID)
      attemptedModels.delete(step.sessionID)
    }
    if (step.kind === "delete") {
      lastPrimaryModels.delete(step.sessionID)
      await clearOwnership(step.sessionID)
    }
  })

  const select = async (agentID: string, workType?: string, sessionID?: string) => {
    await ensureProjectOptions()
    await refresh()
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
    const currentRegistry = registry
    const currentEligibility = failures.apply(baseSnapshot(), currentRegistry, Date.now())
    const pin = pins.get(agentID)
    const candidates = pin ? [pin, ...resolution.plan.filter((candidate) => modelKey(candidate) !== modelKey(pin))] : resolution.plan
    let selection = selectModel(candidates, currentRegistry, currentEligibility, Date.now(), busyFor(sessionID))
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
    async explain(agentID: string, sessionID?: string): Promise<SelectionExplanation> {
      await ensureProjectOptions()
      await refresh()
      return explainSelection(selectedFor(agentID, sessionID))
    },
    select,
    status,
    diagnoseSession,
    refresh(nextEligibility?: ReadonlyMap<string, ModelEligibility>) {
      return refresh(nextEligibility)
    },
    async refreshBudgets() {
      await requestReload()
    },
    async dispose() {
      clearInterval(interval)
      requestKinds.clear()
      attemptedModels.clear()
      lastPrimaryModels.clear()
      await runningHook?.dispose()
      await retryHook?.dispose()
      await promptHook?.dispose()
      await commandRegistration?.dispose()
      await exclusiveGate.dispose()
      if (refreshPromise) await refreshPromise.catch(() => {})
      if (reloadPromise) await reloadPromise
      await registration?.dispose()
    },
  }
}
