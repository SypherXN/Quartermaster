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

type Scope = { providerID: string; modelID?: string }
export interface PersistedCooldown extends Scope {
  until: number
}

function key({ providerID, modelID }: Scope): string {
  return JSON.stringify([providerID, modelID ?? null])
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export class FailureCooldowns {
  private readonly until = new Map<string, number>()
  private readonly durationMs: number

  constructor(durationMs: number) {
    this.durationMs = durationMs
  }

  reportFailure(report: FailureReport, now: number): boolean {
    if (["quota-exhausted", "auth", "cancelled", "other"].includes(report.classification)) return false

    const scope = report.classification === "model-outage" ||
      (report.classification === "temporary-rate-limit" && report.modelID !== undefined)
      ? { providerID: report.providerID, modelID: report.modelID }
      : { providerID: report.providerID }
    const id = key(scope)
    this.until.set(id, Math.max(this.until.get(id) ?? -Infinity, now + this.durationMs))
    return true
  }

  reportSuccess(report: SuccessReport): boolean {
    return this.until.delete(key({
      providerID: report.providerID,
      ...(report.scope === "model" ? { modelID: report.modelID } : {}),
    }))
  }

  snapshot(now: number): PersistedCooldown[] {
    return [...this.until].flatMap(([scopeKey, until]) => {
      if (until <= now) return []
      const [providerID, modelID] = JSON.parse(scopeKey) as [string, string | null]
      return [{ providerID, ...(modelID === null ? {} : { modelID }), until }]
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
