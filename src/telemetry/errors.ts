import { randomUUID } from "node:crypto"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Schema } from "effect"

const PREFIX = "quartermaster:errors:v1:"
const DAY_MS = 86_400_000
export const PROVIDER_ERROR_RETENTION_MS = 90 * DAY_MS
export const PROVIDER_ERROR_MAX_RECORDS = 10_000
const PAGE_SIZE = 1_000

export type ProviderErrorClassification = "rate-limit" | "request-error" | "provider-error" | "unknown"
export interface ProviderErrorRecord {
  id: string
  observedAt: number
  source: "session.retry"
  projectID: string | null
  classification: ProviderErrorClassification
  httpStatus: number | null
  providerID: string | null
  modelID: string | null
  attempt: number
}
export interface ProviderErrorQuery {
  projectID?: string | null
  since?: number
  until?: number
  providerID?: string
  modelID?: string
  limit?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null
const keyFor = (id: string) => `${PREFIX}${encodeURIComponent(id)}`

export function projectRetryError(
  event: unknown,
  id: string = randomUUID(),
  observedAt = Date.now(),
  projectID: string | null = null,
): ProviderErrorRecord | undefined {
  if (!isRecord(event) || !isRecord(event.model) || !isRecord(event.error)) return undefined
  if (!Number.isFinite(observedAt) || !Number.isSafeInteger(event.attempt) || (event.attempt as number) < 1) return undefined
  const status = event.error.status
  const httpStatus = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null
  return {
    id, observedAt, source: "session.retry", projectID,
    classification: httpStatus === 429 ? "rate-limit" : httpStatus === null || httpStatus < 400 ? "unknown" : httpStatus < 500 ? "request-error" : "provider-error",
    httpStatus,
    providerID: nonEmptyString(event.model.providerID),
    modelID: nonEmptyString(event.model.id),
    attempt: event.attempt as number,
  }
}

function asRecord(value: unknown): ProviderErrorRecord | undefined {
  if (!isRecord(value)) return undefined
  const classes: ProviderErrorClassification[] = ["rate-limit", "request-error", "provider-error", "unknown"]
  if (typeof value.id !== "string" || !value.id || !Number.isFinite(value.observedAt) || value.source !== "session.retry" ||
    (value.projectID !== undefined && value.projectID !== null && (typeof value.projectID !== "string" || !value.projectID)) ||
    !classes.includes(value.classification as ProviderErrorClassification) ||
    (value.httpStatus !== null && (typeof value.httpStatus !== "number" || !Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599)) ||
    (value.providerID !== null && (typeof value.providerID !== "string" || !value.providerID)) ||
    (value.modelID !== null && (typeof value.modelID !== "string" || !value.modelID)) ||
    !Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1) return undefined
  return {
    id: value.id, observedAt: value.observedAt as number, source: "session.retry",
    projectID: typeof value.projectID === "string" ? value.projectID : null,
    classification: value.classification as ProviderErrorClassification,
    httpStatus: value.httpStatus as number | null, providerID: value.providerID as string | null,
    modelID: value.modelID as string | null, attempt: value.attempt as number,
  }
}

async function scanAll(storage: Context["storage"]) {
  const entries: Awaited<ReturnType<typeof storage.scan>>["entries"][number][] = []
  let after: string | undefined
  while (true) {
    const page = await storage.scan({ prefix: PREFIX, after, limit: PAGE_SIZE })
    entries.push(...page.entries)
    if (!page.next || page.next === after) return entries
    after = page.next
  }
}

export class ProviderErrorLedger {
  private pending = Promise.resolve()
  private readonly storage: Context["storage"]
  private readonly now: () => number
  private readonly retentionMs: number
  private readonly maxRecords: number

  constructor(storage: Context["storage"], now: () => number = Date.now, retentionMs = PROVIDER_ERROR_RETENTION_MS, maxRecords = PROVIDER_ERROR_MAX_RECORDS) {
    this.storage = storage
    this.now = now
    this.retentionMs = Math.max(1, retentionMs)
    this.maxRecords = Math.max(1, Math.min(PROVIDER_ERROR_MAX_RECORDS, Math.floor(maxRecords)))
  }

  ingest(input: ProviderErrorRecord): Promise<void> {
    const record = asRecord(input)
    if (!record) return Promise.reject(new TypeError("Invalid provider error record"))
    const write = this.pending.catch(() => {}).then(async () => {
      await this.storage.set(keyFor(record.id), record as unknown as Schema.Json)
      await this.prune()
    })
    this.pending = write
    return write
  }

  async list(query: ProviderErrorQuery = {}): Promise<ProviderErrorRecord[]> {
    await this.serialize(() => this.prune())
    const cutoff = this.now() - this.retentionMs
    const entries = await scanAll(this.storage)
    const limit = Math.max(1, Math.min(PROVIDER_ERROR_MAX_RECORDS, Math.floor(query.limit ?? PROVIDER_ERROR_MAX_RECORDS)))
    return entries.map((entry) => ({ entry, record: asRecord(entry.value) }))
      .filter(({ entry, record }) => record !== undefined && entry.key === keyFor(record.id))
      .map(({ record }) => record!)
      .filter((record) => record.observedAt >= cutoff && (query.since === undefined || record.observedAt >= query.since) && (query.until === undefined || record.observedAt <= query.until))
      .filter((record) => query.projectID === undefined || record.projectID === query.projectID)
      .filter((record) => query.providerID === undefined || record.providerID === query.providerID)
      .filter((record) => query.modelID === undefined || record.modelID === query.modelID)
      .sort((a, b) => a.observedAt - b.observedAt || a.id.localeCompare(b.id))
      .slice(-limit)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.catch(() => {}).then(operation)
    this.pending = task.then(() => {}, () => {})
    return task
  }

  private async prune(): Promise<void> {
    const rows = (await scanAll(this.storage)).map((entry) => ({ entry, record: asRecord(entry.value) }))
    const keep = rows.filter(({ entry, record }) => record !== undefined && entry.key === keyFor(record.id) && record.observedAt >= this.now() - this.retentionMs)
      .sort((a, b) => b.record!.observedAt - a.record!.observedAt || b.record!.id.localeCompare(a.record!.id))
      .slice(0, Math.max(1, Math.min(PROVIDER_ERROR_MAX_RECORDS, Math.floor(this.maxRecords))))
    const keys = new Set(keep.map(({ entry }) => entry.key))
    await Promise.all(rows.filter(({ entry, record }) => !record || (entry.key === keyFor(record.id) && !keys.has(entry.key)))
      .map(({ entry }) => this.storage.remove(entry.key)))
  }
}

export async function startProviderErrorCollector(
  ctx: Pick<Context, "session" | "storage">,
  ledger = new ProviderErrorLedger(ctx.storage),
) {
  const registration = await ctx.session.hook("retry", async (event) => {
    let projectID: string | null = null
    if (isRecord(event) && typeof event.sessionID === "string") {
      try {
        projectID = (await ctx.session.get({ sessionID: event.sessionID })).projectID ?? null
      } catch {
        // Legacy or inaccessible sessions remain unattributed.
      }
    }
    const record = projectRetryError(event, undefined, Date.now(), projectID)
    if (!record) return
    try {
      await ledger.ingest(record)
    } catch {
      console.warn("[quartermaster] provider error telemetry write failed")
    }
  })
  return { ledger, dispose: () => registration.dispose() }
}
