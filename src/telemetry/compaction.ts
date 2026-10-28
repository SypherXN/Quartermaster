import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type { Schema } from "effect"
import { sessionKey } from "./session-key.ts"
import type { TokenCounts } from "./types.ts"

const PREFIX = "quartermaster:compaction:v1:"
const DAY_MS = 86_400_000
const RETENTION_MS = 90 * DAY_MS
const MAX_RECORDS_PER_PROJECT = 10_000
const PAGE_SIZE = 1_000

export interface CompactionRecord {
  hostEventID: string
  projectID: string | null
  // Hash of the compacted session. Null on rows stored before this field.
  // The raw session id is not kept.
  sessionKey: string | null
  sourceEvent: "session.compaction.ended" | "session.compaction.failed"
  reason: "auto" | "manual" | null
  providerID: string | null
  modelID: string | null
  variant: string | null
  completedAt: number
  counts: TokenCounts | null
  usageStatus: "reported" | "missing"
  partial: boolean
}

export interface CompactionDraft extends Omit<CompactionRecord, "projectID"> {
  sessionID: string
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : undefined

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

const whole = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

function countsFrom(value: unknown): { counts: TokenCounts; partial: boolean } | null {
  if (!isObject(value) || !whole(value.input) || !whole(value.output)) return null
  const cache = isObject(value.cache) ? value.cache : {}
  const reasoning = whole(value.reasoning) ? value.reasoning : null
  const cacheRead = whole(cache.read) ? cache.read : null
  const cacheWrite = whole(cache.write) ? cache.write : null
  const partial = reasoning === null || !isObject(value.cache) || cacheRead === null || cacheWrite === null
  return {
    partial,
    counts: {
      input: value.input,
      output: value.output,
      reasoning: reasoning ?? 0,
      cacheRead: cacheRead ?? 0,
      cacheWrite: cacheWrite ?? 0,
    },
  }
}

// The compaction event's own token object. Summary text and provider state stay out.
export function projectCompactionEvent(event: unknown): CompactionDraft | undefined {
  if (!isObject(event) || !isObject(event.data)) return undefined
  if (event.type !== "session.compaction.ended" && event.type !== "session.compaction.failed") return undefined
  const hostEventID = text(event.id)
  const sessionID = text(event.data.sessionID)
  if (!hostEventID || !sessionID || !finite(event.created)) return undefined
  const model = isObject(event.data.model) ? event.data.model : undefined
  const providerID = text(model?.providerID)
  const modelID = text(model?.id)
  const hasModel = providerID !== undefined && modelID !== undefined
  const parsed = countsFrom(event.data.tokens)
  const reason = event.data.reason === "auto" || event.data.reason === "manual" ? event.data.reason : null
  return {
    hostEventID,
    sessionID,
    sessionKey: sessionKey(sessionID),
    sourceEvent: event.type,
    reason,
    providerID: hasModel ? providerID : null,
    modelID: hasModel ? modelID : null,
    variant: hasModel ? text(model?.variant) ?? null : null,
    completedAt: event.created,
    counts: parsed?.counts ?? null,
    usageStatus: parsed ? "reported" : "missing",
    partial: parsed?.partial ?? false,
  }
}

const keyFor = (hostEventID: string) => `${PREFIX}${encodeURIComponent(hostEventID)}`

function asRecord(value: unknown): CompactionRecord | undefined {
  if (!isObject(value)) return undefined
  const item = value as Partial<CompactionRecord>
  const counts = item.counts
  const count = (entry: unknown) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0
  if (
    !text(item.hostEventID) ||
    (item.projectID !== null && !text(item.projectID)) ||
    (item.sourceEvent !== "session.compaction.ended" && item.sourceEvent !== "session.compaction.failed") ||
    (item.reason !== null && item.reason !== "auto" && item.reason !== "manual") ||
    (item.providerID !== null && !text(item.providerID)) ||
    (item.modelID !== null && !text(item.modelID)) ||
    (item.variant !== null && !text(item.variant)) ||
    typeof item.completedAt !== "number" || !Number.isSafeInteger(item.completedAt) || item.completedAt < 0 ||
    (item.usageStatus !== "reported" && item.usageStatus !== "missing") ||
    typeof item.partial !== "boolean" ||
    (counts !== null && (!counts || !count(counts.input) || !count(counts.output) || !count(counts.reasoning) || !count(counts.cacheRead) || !count(counts.cacheWrite)))
  ) return undefined
  return {
    hostEventID: item.hostEventID!,
    projectID: text(item.projectID) ?? null,
    sourceEvent: item.sourceEvent,
    reason: item.reason ?? null,
    providerID: item.providerID ?? null,
    modelID: item.modelID ?? null,
    variant: item.variant ?? null,
    completedAt: item.completedAt,
    usageStatus: item.usageStatus,
    partial: item.partial,
    counts: counts ? { ...counts } : null,
    // Absent on rows stored before the hash existed. Anything else is dropped
    // so a raw session id cannot ride out on this field.
    sessionKey: text(item.sessionKey) && /^[0-9a-f]{12}$/.test(item.sessionKey!) ? item.sessionKey! : null,
  }
}

export class CompactionLedger {
  private pending = Promise.resolve()
  private readonly storage: StorageDomain
  private readonly now: () => number
  private readonly retentionMs: number
  private readonly maxRecords: number

  constructor(storage: StorageDomain, now: () => number = Date.now, retentionMs = RETENTION_MS, maxRecords = MAX_RECORDS_PER_PROJECT) {
    this.storage = storage
    this.now = now
    this.retentionMs = Math.max(1, retentionMs)
    this.maxRecords = Math.max(1, Math.min(MAX_RECORDS_PER_PROJECT, Math.floor(maxRecords)))
  }

  ingest(record: CompactionRecord): Promise<void> {
    const write = this.pending.catch(() => {}).then(async () => {
      const existing = asRecord(await this.storage.get(keyFor(record.hostEventID)).catch(() => undefined))
      if (existing) return
      await this.storage.set(keyFor(record.hostEventID), record as unknown as Schema.Json)
      await this.prune(record.projectID)
    })
    this.pending = write.then(() => {}, () => {})
    return write
  }

  async list(projectID: string): Promise<CompactionRecord[]> {
    await this.serialize(() => this.prune(projectID))
    const cutoff = this.now() - this.retentionMs
    return (await this.scan())
      .map((entry) => asRecord(entry.value))
      .filter((record): record is CompactionRecord => record !== undefined && record.projectID === projectID && record.completedAt >= cutoff)
      .sort((a, b) => a.completedAt - b.completedAt || a.hostEventID.localeCompare(b.hostEventID))
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.catch(() => {}).then(operation)
    this.pending = task.then(() => {}, () => {})
    return task
  }

  private async scan() {
    const entries: Awaited<ReturnType<StorageDomain["scan"]>>["entries"][number][] = []
    let after: string | undefined
    while (true) {
      const page = await this.storage.scan({ prefix: PREFIX, after, limit: PAGE_SIZE })
      entries.push(...page.entries)
      if (!page.next || page.next === after) return entries
      after = page.next
    }
  }

  private async prune(projectID: string | null): Promise<void> {
    const cutoff = this.now() - this.retentionMs
    const valid = (await this.scan()).flatMap((entry) => {
      const record = asRecord(entry.value)
      return record && entry.key === keyFor(record.hostEventID) ? [{ entry, record }] : []
    })
    const projectRows = valid
      .filter(({ record }) => record.projectID === projectID && record.completedAt >= cutoff)
      .sort((a, b) => b.record.completedAt - a.record.completedAt || a.entry.key.localeCompare(b.entry.key))
    const keep = new Set(projectRows.slice(0, this.maxRecords).map(({ entry }) => entry.key))
    await Promise.all(valid
      .filter(({ record, entry }) => record.projectID === projectID && !keep.has(entry.key))
      .map(({ entry }) => this.storage.remove(entry.key)))
  }
}
