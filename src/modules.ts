import type { ModelRef, QuartermasterConfig } from "./config.ts"
import { moduleUsageDecision, tracksQuota, type ModuleQuota } from "./eligibility.ts"
import { FailureCooldowns, type PersistedCooldown } from "./failures.ts"
import { modelKey, selectModel } from "./select.ts"
import { ProjectConfigurationUnresolved } from "./project-options.ts"
import type { UsageReadResult } from "./usage.ts"

export const MODULE_COOLDOWN_STORAGE_KEY = "modules/cooldowns-v1"
// The project options read is a loopback HTTP round trip. A permission review must not spend its budget on it.
export const MODULE_CONFIG_READ_BUDGET_MS = 250

export class ModuleConfigurationUnavailable extends Error {
  readonly reason = "provenance-unavailable"
  readonly detail: string
  constructor(detail: string) {
    super(`Module configuration is unavailable: ${detail}`)
    this.name = "ModuleConfigurationUnavailable"
    this.detail = detail
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

interface ModuleStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export interface ModuleCooldownReport {
  module: string
  providerID: string
  modelID: string
  reason: "rate-limit" | "temporary-unavailable"
}

export interface ModuleCandidate extends ModelRef {
  reason: "declared" | "cooldown" | "limited" | "usage-unavailable"
  quota: ModuleQuota
  health: "unknown"
  blockedUntil?: number
  remainingMs?: number
}

export type ModuleSelection = {
  module: string
  evaluatedAt: number
  candidates: ModuleCandidate[]
} & (
  | { status: "selected"; selected: ModelRef }
  | { status: "no-module" }
  | { status: "no-eligible"; nextEligibleAt?: number }
)

type StoredCooldown = { module: string; providerID: string; modelID: string; until: number }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export class ModuleCooldowns {
  private readonly cooldowns = new Map<string, FailureCooldowns>()
  private readonly config: Pick<QuartermasterConfig, "modules" | "usageSources" | "quotaExemptModels">
  private readonly storage: ModuleStorage
  private readonly storageKey: string
  private readonly now: () => number
  private pending: Promise<void> = Promise.resolve()
  private refreshPending: Promise<void> = Promise.resolve()
  private pruned = false
  private configurationError: { reason: string; message: string } | undefined
  private configurationRefresh: Promise<void> = Promise.resolve()
  private readonly refreshOptions?: () => Promise<unknown>
  private readonly readUsage?: () => Promise<UsageReadResult>

  private constructor(
    config: Pick<QuartermasterConfig, "modules" | "usageSources" | "quotaExemptModels">,
    storage: ModuleStorage,
    projectID: string,
    now: () => number,
    refreshOptions?: () => Promise<unknown>,
    readUsage?: () => Promise<UsageReadResult>,
  ) {
    if (typeof projectID !== "string" || !projectID.trim() || projectID.trim() !== projectID) {
      throw new Error("module cooldowns: expected a non-empty project ID")
    }
    this.config = config
    this.storage = storage
    this.storageKey = `${MODULE_COOLDOWN_STORAGE_KEY}/${encodeURIComponent(projectID)}`
    this.now = now
    this.refreshOptions = refreshOptions
    this.readUsage = readUsage
  }

  static async load(
    config: Pick<QuartermasterConfig, "modules" | "usageSources" | "quotaExemptModels">,
    storage: ModuleStorage,
    projectID: string,
    now: () => number = Date.now,
    refreshOptions?: () => Promise<unknown>,
    readUsage?: () => Promise<UsageReadResult>,
  ): Promise<ModuleCooldowns> {
    const result = new ModuleCooldowns(config, storage, projectID, now, refreshOptions, readUsage)
    const stored = await storage.get(result.storageKey)
    const time = result.time()
    if (!isRecord(stored) || !Array.isArray(stored.cooldowns)) return result

    const rows: StoredCooldown[] = []
    for (const row of stored.cooldowns) {
      if (
        !isRecord(row) ||
        Object.keys(row).some(field => !["module", "providerID", "modelID", "until"].includes(field)) ||
        typeof row.module !== "string" || typeof row.providerID !== "string" || typeof row.modelID !== "string" ||
        typeof row.until !== "number" || !Number.isSafeInteger(row.until) || row.until <= time
      ) continue
      if (!result.candidate(row.module, row.providerID, row.modelID)) {
        result.pruned = true
        continue
      }
      rows.push({ module: row.module, providerID: row.providerID, modelID: row.modelID, until: row.until })
    }
    // Native restore is last-write-wins; restore duplicates longest-last without changing native semantics.
    for (const row of rows.sort((a, b) => a.until - b.until)) {
      result.forModule(row.module).restore([row], time)
    }
    if (result.pruned) {
      await result.persist(time)
      result.pruned = false
    }
    return result
  }

  snapshot(module: string): PersistedCooldown[] {
    return this.cooldowns.get(module)?.snapshot(this.time()) ?? []
  }

  async refresh(): Promise<void> {
    const refresh = this.refreshPending.catch(() => {}).then(async () => {
      await this.refreshConfiguration()
      const now = this.time()
      for (const [module, previous] of this.cooldowns) {
        const rows = previous.snapshot(now)
        const kept = rows.filter(row => row.modelID !== undefined && this.candidate(module, row.providerID, row.modelID))
        if (!this.config.modules || !Object.hasOwn(this.config.modules, module)) {
          this.cooldowns.delete(module)
          this.pruned = true
        } else {
          const next = new FailureCooldowns(this.config.modules[module].cooldownMs)
          next.restore(kept, now)
          this.cooldowns.set(module, next)
          if (kept.length !== rows.length) this.pruned = true
        }
      }
      if (this.pruned) {
        await this.persist(now)
        this.pruned = false
      }
    })
    this.refreshPending = refresh
    return refresh
  }

  async query(module: string): Promise<ModuleSelection> {
    await this.refresh()
    // Without a known configuration there is nothing to recommend from; say so instead of guessing.
    if (!this.hasProfiles() && this.configurationError) {
      throw new ModuleConfigurationUnavailable(this.configurationError.message)
    }
    const usage = this.moduleTracksQuota(module) ? await this.readTrackedUsage() : undefined
    return this.select(module, usage)
  }

  /** A failed configuration read is recorded, not fatal: the last known good configuration stays in place. */
  noteConfigurationFailure(error: unknown): void {
    this.configurationError = { reason: "provenance-unavailable", message: errorMessage(error) }
    console.warn(`[quartermaster] module configuration refresh failed: ${this.configurationError.message}`)
  }

  // ponytail: the read is bounded; a stalled round trip leaves the last known good configuration in place.
  private async refreshConfiguration(): Promise<void> {
    if (!this.refreshOptions) return
    const read = this.configurationRefresh.catch(() => {}).then(async () => {
      try {
        await this.refreshOptions!()
        this.configurationError = undefined
      } catch (error) {
        // Unreadable provenance is not invalid configuration: keep the last known good settings.
        if (!(error instanceof ProjectConfigurationUnresolved)) throw error
        this.noteConfigurationFailure(error)
      }
    })
    this.configurationRefresh = read
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = new Promise<void>(resolve => { timer = setTimeout(resolve, MODULE_CONFIG_READ_BUDGET_MS) })
    try {
      await Promise.race([read, budget])
    } finally {
      clearTimeout(timer)
    }
  }

  private hasProfiles(): boolean {
    const modules = this.config.modules
    return modules !== undefined && Object.keys(modules).length > 0
  }

  async selections(): Promise<Record<string, ModuleSelection>> {
    const names = Object.keys(this.config.modules ?? {})
    const usage = names.some(name => this.moduleTracksQuota(name)) ? await this.readTrackedUsage() : undefined
    return Object.fromEntries(names.map(name => [name, this.select(name, usage)]))
  }

  select(module: string, usage?: UsageReadResult): ModuleSelection {
    const evaluatedAt = this.time()
    const profiles = this.config.modules
    if (!profiles || !Object.hasOwn(profiles, module)) {
      return { module, evaluatedAt, status: "no-module", candidates: [] }
    }
    const models = profiles[module].models.map(({ cooldownMs, ...model }) => model)
    const deadlines = new Map((this.cooldowns.get(module)?.snapshot(evaluatedAt) ?? [])
      .flatMap(row => row.modelID === undefined ? [] : [
        [modelKey({ providerID: row.providerID, modelID: row.modelID }), row.until] as const,
      ]))
    const judged = models.map(model => ({
      model,
      decision: moduleUsageDecision(model, this.config.usageSources, this.config.quotaExemptModels, usage),
      blockedUntil: deadlines.get(modelKey(model)),
    }))
    // Declared means eligible for a direct call. Provider health stays unknown.
    // Mapped quota can skip a candidate; it never clears a cooldown or uses a reset time.
    const eligibility = new Map(judged.map(({ model, decision, blockedUntil }) => [modelKey(model), {
      status: decision.skip ? "unknown" as const : "available" as const,
      cooldownUntil: blockedUntil,
    }]))
    const result = selectModel(models, models, eligibility, evaluatedAt)
    const candidates: ModuleCandidate[] = judged.map(({ model, decision, blockedUntil }) => ({
      ...model, quota: decision.quota, health: "unknown",
      reason: blockedUntil === undefined ? decision.skip ?? "declared" : "cooldown",
      ...(blockedUntil === undefined ? {} : { blockedUntil, remainingMs: blockedUntil - evaluatedAt }),
    }))
    const base = { module, evaluatedAt, candidates }
    if (result.status === "selected") return { ...base, status: "selected", selected: result.model }
    const nextEligibleAt = candidates.reduce((earliest, model) => Math.min(earliest, model.blockedUntil ?? Infinity), Infinity)
    return { ...base, status: "no-eligible", ...(Number.isFinite(nextEligibleAt) ? { nextEligibleAt } : {}) }
  }

  async report(input: ModuleCooldownReport): Promise<
    | { accepted: true; module: string; providerID: string; modelID: string; blockedUntil: number }
    | { accepted: false; reason: "unknown-module" | "unknown-model" }
  > {
    if (this.refreshOptions) await this.refresh()
    const { module, providerID, modelID, reason } = input
    if (reason !== "rate-limit" && reason !== "temporary-unavailable") {
      throw new Error("module cooldowns: invalid report reason")
    }
    if (!this.config.modules || !Object.hasOwn(this.config.modules, module)) {
      return { accepted: false, reason: "unknown-module" }
    }
    const candidate = this.candidate(module, providerID, modelID)
    if (!candidate) return { accepted: false, reason: "unknown-model" }
    const now = this.time()
    const until = now + candidate.cooldownMs
    if (!Number.isSafeInteger(until) || until <= now) {
      throw new Error("module cooldowns: unsafe deadline")
    }
    const failures = this.forModule(module)
    failures.setDuration(candidate.cooldownMs)
    failures.reportFailure({
      providerID, modelID,
      classification: reason === "rate-limit" ? "temporary-rate-limit" : "model-outage",
    }, now)
    const blockedUntil = failures.snapshot(now).find(row => row.providerID === providerID && row.modelID === modelID)!.until
    await this.persist(now)
    return { accepted: true, module, providerID, modelID, blockedUntil }
  }

  private async readTrackedUsage(): Promise<UsageReadResult> {
    if (!this.readUsage) return { status: "unavailable", reason: "rpc-error" }
    try {
      return await this.readUsage()
    } catch {
      return { status: "unavailable", reason: "rpc-error" }
    }
  }

  private moduleTracksQuota(module: string): boolean {
    const profiles = this.config.modules
    if (!profiles || !Object.hasOwn(profiles, module)) return false
    return profiles[module].models.some(model =>
      tracksQuota(model, this.config.usageSources, this.config.quotaExemptModels))
  }

  private time(): number {
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("module cooldowns: invalid clock")
    return now
  }

  private candidate(module: string, providerID: string, modelID: string) {
    const profiles = this.config.modules
    if (!profiles || !Object.hasOwn(profiles, module)) return undefined
    return profiles[module].models.find(model => model.providerID === providerID && model.modelID === modelID)
  }

  private forModule(module: string): FailureCooldowns {
    let failures = this.cooldowns.get(module)
    if (!failures) {
      failures = new FailureCooldowns(this.config.modules![module].cooldownMs)
      this.cooldowns.set(module, failures)
    }
    return failures
  }

  private persist(now: number): Promise<void> {
    const state = {
      cooldowns: [...this.cooldowns].flatMap(([module, failures]) =>
        failures.snapshot(now).map(row => ({ module, ...row }))),
    }
    const write = this.pending.catch(() => {}).then(() => this.storage.set(this.storageKey, state))
    this.pending = write
    return write
  }
}
