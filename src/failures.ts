import type { ModelRef } from "./config.ts"
import { modelKey, type ModelEligibility } from "./select.ts"

export type FailureClassification =
  | "provider-outage"
  | "model-outage"
  | "temporary-rate-limit"
  | "quota-exhausted"
  | "auth"
  | "cancelled"
  | "other"

export type FailureReport =
  | { providerID: string; classification: "provider-outage"; modelID?: string }
  | { providerID: string; classification: "model-outage"; modelID: string }
  | { providerID: string; classification: "temporary-rate-limit"; modelID?: string }
  | {
      providerID: string
      classification: "quota-exhausted" | "auth" | "cancelled" | "other"
      modelID?: string
    }

export type SuccessReport =
  | { providerID: string; scope: "provider" }
  | { providerID: string; scope: "model"; modelID: string }

export interface RetryFailureDecision {
  fallback: boolean
  report?: FailureReport
}

// The host retries plain rate-limit messages itself, so a provider that reports one only as text
// (no status, no provider.rate-limit type) must still be recognised here.
const RATE_LIMIT_TEXT = /rate.?limit|too many requests/i

export function classifyRetryFailure(
  error: { type?: unknown; status?: unknown; message?: unknown; response?: unknown },
  providerID: string,
  modelID: string,
): RetryFailureDecision {
  const type = typeof error.type === "string" ? error.type : ""
  const status = typeof error.status === "number" ? error.status : undefined
  const body = isRecord(error.response) && typeof error.response.body === "string" ? error.response.body : ""
  const text = `${typeof error.message === "string" ? error.message : ""}\n${body}`

  if (type === "provider.quota" || status === 402) {
    return { fallback: false, report: { providerID, modelID, classification: "quota-exhausted" } }
  }
  if (type === "provider.auth" || type === "permission.rejected" || status === 401 || status === 403) {
    return { fallback: false, report: { providerID, modelID, classification: "auth" } }
  }
  if (type === "provider.rate-limit" || status === 429 || RATE_LIMIT_TEXT.test(text)) {
    return { fallback: true, report: { providerID, modelID, classification: "temporary-rate-limit" } }
  }
  if (type === "provider.invalid-request" || type === "provider.no-route") {
    return status === 404 || status === 410 || type === "provider.no-route"
      ? { fallback: false, report: { providerID, modelID, classification: "model-outage" } }
      : { fallback: false }
  }
  if (type === "provider.invalid-output" || type === "provider.content-filter" || type === "provider.unsupported-operation" || type === "provider.unknown" || type === "unknown" || type === "provider.timeout") {
    return { fallback: false }
  }
  if (type === "provider.internal" || type === "provider.transport" || status === 408 || status === 409 || (status !== undefined && status >= 500)) {
    return { fallback: true, report: { providerID, classification: "provider-outage" } }
  }
  return { fallback: false }
}

type Scope = { providerID: string; modelID?: string }
export interface PersistedCooldown extends Scope {
  until: number
  occurredAt?: number
  classification?: FailureClassification
}

function key({ providerID, modelID }: Scope): string {
  return JSON.stringify([providerID, modelID ?? null])
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export class FailureCooldowns {
  private readonly until = new Map<string, number>()
  private readonly evidence = new Map<string, { occurredAt: number; classification: FailureClassification }>()
  private durationMs: number
  private groups: readonly ModelRef[][]

  constructor(durationMs: number, groups: readonly ModelRef[][] = []) {
    this.durationMs = durationMs
    this.groups = groups
  }

  setDuration(durationMs: number): void {
    this.durationMs = durationMs
  }

  setGroups(groups: readonly ModelRef[][]): void {
    this.groups = groups
  }

  /**
   * Record a failure. `deadline` is a provider-stated reset time: it can extend the configured
   * cooldown but never shorten it below it.
   */
  reportFailure(report: FailureReport, now: number, deadline?: number): boolean {
    if (!Number.isFinite(now) || now < 0) return false
    for (const [id, until] of this.until) {
      if (until <= now) {
        this.until.delete(id)
        this.evidence.delete(id)
      }
    }
    if (["auth", "cancelled", "other"].includes(report.classification)) return false
    if (report.classification === "quota-exhausted" && !report.modelID) return false

    const until = deadline === undefined || !Number.isFinite(deadline)
      ? now + this.durationMs
      : Math.max(now + this.durationMs, deadline)
    let changed = false
    for (const scope of this.cooldownScopes(report)) {
      const id = key(scope)
      const existing = this.until.get(id)
      if (existing === undefined || until > existing) {
        this.until.set(id, until)
        this.evidence.set(id, { occurredAt: now, classification: report.classification })
        changed = true
        continue
      }
      // The deadline does not extend, but a failure of that model itself must not be masked by a
      // shared bucket cooldown: the more specific evidence wins.
      const current = this.evidence.get(id)?.classification
      const spreadable = ["temporary-rate-limit", "quota-exhausted"].includes(report.classification)
      if (current !== undefined && ["temporary-rate-limit", "quota-exhausted"].includes(current) && !spreadable) {
        this.evidence.set(id, { occurredAt: now, classification: report.classification })
        changed = true
      }
    }
    return changed
  }

  private cooldownScopes(report: FailureReport): Scope[] {
    const modelScoped = report.classification === "model-outage" ||
      (["temporary-rate-limit", "quota-exhausted"].includes(report.classification) && report.modelID !== undefined)
    const scope: Scope = modelScoped
      ? { providerID: report.providerID, modelID: report.modelID }
      : { providerID: report.providerID }
    // Zen reports a shared free-tier bucket as provider.quota, often with status 429.
    // A configured group therefore shares both temporary rate limits and quota.
    if (!["temporary-rate-limit", "quota-exhausted"].includes(report.classification) || report.modelID === undefined) return [scope]
    const group = this.groups.find((members) => members.some((model) =>
      model.providerID === report.providerID && model.modelID === report.modelID))
    return group?.map((model) => ({ providerID: model.providerID, modelID: model.modelID })) ?? [scope]
  }

  reportSuccess(report: SuccessReport): boolean {
    const id = key({
      providerID: report.providerID,
      ...(report.scope === "model" ? { modelID: report.modelID } : {}),
    })
    this.evidence.delete(id)
    return this.until.delete(id)
  }

  /**
   * Clear the cooldown of one model and of every member of its shared rate-limit group: the
   * bucket recovered. Only cooldown entries are removed; provider-scoped and unrelated state stay.
   */
  clear(providerID: string, modelID: string): boolean {
    const group = this.groups.find((members) => members.some((model) =>
      model.providerID === providerID && model.modelID === modelID))
    const scopes = group?.map((model) => ({ providerID: model.providerID, modelID: model.modelID })) ?? [{ providerID, modelID }]
    let changed = false
    for (const scope of scopes) {
      const id = key(scope)
      // Only a rate-limit or quota cooldown belongs to the bucket. An outage cooldown of a group
      // member stays: the bucket recovered, that model did not.
      const classification = this.evidence.get(id)?.classification
      if (classification !== undefined && !["temporary-rate-limit", "quota-exhausted"].includes(classification)) continue
      if (this.until.delete(id)) changed = true
      this.evidence.delete(id)
    }
    return changed
  }

  /**
   * Model-scoped cooldown records, expired entries included: the models known to be rate limited.
   * An expired record is what marks a bucket as still limited after its own floor ran out.
   */
  knownLimitedModels(): { providerID: string; modelID: string; until: number }[] {
    const limited: { providerID: string; modelID: string; until: number }[] = []
    for (const [scopeKey, until] of this.until) {
      const [providerID, modelID] = JSON.parse(scopeKey) as [string, string | null]
      if (modelID === null) continue
      limited.push({ providerID, modelID, until })
    }
    return limited
  }

  snapshot(now: number, includeEvidence = false): PersistedCooldown[] {
    return [...this.until].flatMap(([scopeKey, until]) => {
      if (until <= now) return []
      const [providerID, modelID] = JSON.parse(scopeKey) as [string, string | null]
      return [{ providerID, ...(modelID === null ? {} : { modelID }), until,
        ...(includeEvidence ? this.evidence.get(scopeKey) : {}) }]
    })
  }

  restore(value: unknown, now: number): void {
    const entries = Array.isArray(value)
      ? value
      : isRecord(value) && Array.isArray(value.cooldowns)
        ? value.cooldowns
        : []
    for (const entry of entries) {
      if (
        !isRecord(entry) ||
        typeof entry.providerID !== "string" || !entry.providerID ||
        (entry.modelID !== undefined && (typeof entry.modelID !== "string" || !entry.modelID)) ||
        typeof entry.until !== "number" || !Number.isFinite(entry.until) || entry.until <= now
      ) continue
      const scope: Scope = { providerID: entry.providerID }
      if (typeof entry.modelID === "string") scope.modelID = entry.modelID
      this.until.set(key(scope), entry.until)
      if (typeof entry.occurredAt === "number" && Number.isFinite(entry.occurredAt) &&
        entry.occurredAt >= 0 && entry.occurredAt <= now && entry.occurredAt < entry.until &&
        ["provider-outage", "model-outage", "temporary-rate-limit", "quota-exhausted"].includes(String(entry.classification))) {
        this.evidence.set(key(scope), { occurredAt: entry.occurredAt, classification: entry.classification as FailureClassification })
      }
    }
  }

  apply(
    eligibility: ReadonlyMap<string, ModelEligibility>,
    registry: readonly ModelRef[],
    now: number,
  ): ReadonlyMap<string, ModelEligibility> {
    const result = new Map(eligibility)
    for (const model of registry) {
      const cooldownUntil = Math.max(
        this.until.get(key({ providerID: model.providerID })) ?? 0,
        this.until.get(key({ providerID: model.providerID, modelID: model.modelID })) ?? 0,
      )
      const id = modelKey(model)
      const status = result.get(id)
      if (status && cooldownUntil > now) result.set(id, { ...status, cooldownUntil })
    }
    return result
  }
}
