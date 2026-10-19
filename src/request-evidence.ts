import type { ModelRef } from "./config.ts"

export interface RequestEvidence {
  sessionID: string
  kind: "primary" | "compaction"
  agent: string
  model: ModelRef
  observedAt: number
  endedAt?: number
  managed: boolean
}

// ponytail: bounded in-memory evidence; no attribution across restarts without a host request ID.
export class RequestEvidenceHistory {
  private rows: RequestEvidence[] = []
  private observedFailures = new Map<string, number>()
  private overflowUntil = 0
  private readonly retentionMs: number
  private readonly limit: number
  constructor(retentionMs = 900_000, limit = 512) {
    this.retentionMs = retentionMs
    this.limit = limit
  }

  record(request: RequestEvidence, now: number): void {
    this.rows = this.rows.filter((row) => row.observedAt >= now - this.retentionMs)
    this.rows.push(request)
    // ponytail: overflow quarantines attribution globally; use per-session bounds if throughput needs it.
    if (this.rows.length > this.limit) this.overflowUntil = now + this.retentionMs
    this.rows = this.rows.slice(-this.limit)
  }

  claimFailure(sessionID: string, kind: RequestEvidence["kind"], occurredAt: number, now: number): boolean {
    for (const [key, time] of this.observedFailures) if (time < now - this.retentionMs) this.observedFailures.delete(key)
    const key = JSON.stringify([sessionID, kind, occurredAt])
    if (this.observedFailures.has(key)) return false
    this.observedFailures.set(key, occurredAt)
    if (this.observedFailures.size > this.limit) this.observedFailures.delete(this.observedFailures.keys().next().value!)
    return true
  }

  match(sessionID: string, kind: RequestEvidence["kind"], occurredAt: number, now: number): RequestEvidence | undefined {
    if (now < this.overflowUntil || !Number.isFinite(occurredAt) || occurredAt < now - this.retentionMs || occurredAt > now) return undefined
    const candidates = this.rows.filter((row) => row.sessionID === sessionID && row.kind === kind &&
      row.observedAt <= occurredAt && (row.endedAt === undefined || occurredAt <= row.endedAt))
    const first = candidates[0]
    return first && candidates.every((row) => row.agent === first.agent && row.managed === first.managed &&
      row.model.providerID === first.model.providerID && row.model.modelID === first.model.modelID &&
      row.model.variant === first.model.variant) ? first : undefined
  }

  end(sessionID: string, kind: RequestEvidence["kind"], occurredAt: number, now: number): void {
    if (!Number.isFinite(occurredAt) || occurredAt > now) return
    for (const row of this.rows) {
      if (row.sessionID === sessionID && row.kind === kind && row.endedAt === undefined && row.observedAt <= occurredAt) row.endedAt = occurredAt
    }
  }

  delete(sessionID: string): void {
    this.rows = this.rows.filter((row) => row.sessionID !== sessionID)
    for (const key of this.observedFailures.keys()) if ((JSON.parse(key) as string[])[0] === sessionID) this.observedFailures.delete(key)
  }

  clear(): void { this.rows = []; this.observedFailures.clear(); this.overflowUntil = 0 }
}
