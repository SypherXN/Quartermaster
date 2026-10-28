import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type { Schema } from "effect"

const PREFIX = "quartermaster:direct-usage:v1:"
const DAY_MS = 86_400_000
const RETENTION_MS = 90 * DAY_MS
const MAX_RECORDS_PER_PROJECT = 10_000
const PAGE_SIZE = 1_000
const MAX_ID = 128
const MAX_MODEL = 256

export interface DirectUsageCounts {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

// A plugin-owned call that never became a host step. The usage id is the
// caller's idempotency key and is not copied into reports.
export interface DirectUsageRecord {
  projectID: string
  pluginID: string
  pluginName: string
  usageID: string
  providerID: string
  modelID: string
  variant: string | null
  reportedAt: number
  counts: DirectUsageCounts
  partial: boolean
}

export interface DirectUsageInput {
  projectID: string
  pluginID: string
  pluginName: string
  usageID: string
  providerID: string
  modelID: string
  variant?: string | null
  counts: {
    input: number
    output: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
  }
}

const keyFor = (record: Pick<DirectUsageRecord, "projectID" | "pluginID" | "usageID">) =>
  `${PREFIX}${encodeURIComponent(JSON.stringify([record.projectID, record.pluginID, record.usageID]))}`

const id = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value

const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0

function asRecord(value: unknown): DirectUsageRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const item = value as Partial<DirectUsageRecord>
  const counts = item.counts
  if (
    !id(item.projectID, MAX_MODEL) || !id(item.pluginID, MAX_ID) || !id(item.pluginName, MAX_ID) ||
    !id(item.usageID, MAX_ID) || !id(item.providerID, MAX_MODEL) || !id(item.modelID, MAX_MODEL) ||
    (item.variant !== null && !id(item.variant, MAX_ID)) ||
    typeof item.reportedAt !== "number" || !Number.isSafeInteger(item.reportedAt) || item.reportedAt < 0 ||
    typeof item.partial !== "boolean" || !counts ||
    !count(counts.input) || !count(counts.output) || !count(counts.reasoning) ||
    !count(counts.cacheRead) || !count(counts.cacheWrite)
  ) return undefined
  return {
    projectID: item.projectID!,
    pluginID: item.pluginID!,
    pluginName: item.pluginName!,
    usageID: item.usageID!,
    providerID: item.providerID!,
    modelID: item.modelID!,
    variant: item.variant ?? null,
    reportedAt: item.reportedAt,
    partial: item.partial,
    counts: {
      input: counts.input,
      output: counts.output,
      reasoning: counts.reasoning,
      cacheRead: counts.cacheRead,
      cacheWrite: counts.cacheWrite,
    },
  }
}

export function directUsageFromInput(input: DirectUsageInput, reportedAt: number): DirectUsageRecord {
  const provided = input.counts
  const partial = provided.reasoning === undefined || provided.cacheRead === undefined || provided.cacheWrite === undefined
  const record = asRecord({
    projectID: input.projectID,
    pluginID: input.pluginID,
    pluginName: input.pluginName,
    usageID: input.usageID,
    providerID: input.providerID,
    modelID: input.modelID,
    variant: input.variant ?? null,
    reportedAt,
    partial,
    counts: {
      input: provided.input,
      output: provided.output,
      reasoning: provided.reasoning ?? 0,
      cacheRead: provided.cacheRead ?? 0,
      cacheWrite: provided.cacheWrite ?? 0,
    },
  })
  if (!record) throw new TypeError("Invalid direct usage report")
  return record
}

export class DirectUsageLedger {
  private pending = Promise.resolve()
  private readonly storage: StorageDomain
  private readonly now: () => number
  private readonly retentionMs: number
  private readonly maxRecords: number

  constructor(
    storage: StorageDomain,
    now: () => number = Date.now,
    retentionMs = RETENTION_MS,
    maxRecords = MAX_RECORDS_PER_PROJECT,
  ) {
    this.storage = storage
    this.now = now
    this.retentionMs = Math.max(1, retentionMs)
    this.maxRecords = Math.max(1, Math.min(MAX_RECORDS_PER_PROJECT, Math.floor(maxRecords)))
  }

  record(input: DirectUsageInput): Promise<{ replaced: boolean }> {
    const write = this.pending.catch(() => {}).then(async () => {
      let existing: DirectUsageRecord | undefined
      try {
        existing = asRecord(await this.storage.get(keyFor({
          projectID: input.projectID, pluginID: input.pluginID, usageID: input.usageID,
        })))
      } catch {
        existing = undefined
      }
      const record = directUsageFromInput(input, existing?.reportedAt ?? this.now())
      if (existing && (existing.projectID !== record.projectID || existing.pluginID !== record.pluginID || existing.usageID !== record.usageID)) {
        throw new TypeError("Invalid direct usage report")
      }
      await this.storage.set(keyFor(record), record as unknown as Schema.Json)
      await this.prune(record.projectID)
      return { replaced: existing !== undefined }
    })
    this.pending = write.then(() => {}, () => {})
    return write
  }

  async list(projectID: string): Promise<DirectUsageRecord[]> {
    await this.serialize(() => this.prune(projectID))
    const entries = await this.scan()
    const cutoff = this.now() - this.retentionMs
    return entries
      .map((entry) => ({ entry, record: asRecord(entry.value) }))
      .filter(({ entry, record }) => record !== undefined && entry.key === keyFor(record))
      .map(({ record }) => record!)
      .filter((record) => record.projectID === projectID && record.reportedAt >= cutoff)
      .sort((a, b) => a.reportedAt - b.reportedAt || a.usageID.localeCompare(b.usageID))
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

  private async prune(projectID: string): Promise<void> {
    const entries = await this.scan()
    const cutoff = this.now() - this.retentionMs
    const valid = entries.map((entry) => ({ entry, record: asRecord(entry.value) }))
      .filter(({ entry, record }) => record !== undefined && entry.key === keyFor(record))
    const projectRows = valid.filter(({ record }) => record!.projectID === projectID && record!.reportedAt >= cutoff)
      .sort((a, b) => b.record!.reportedAt - a.record!.reportedAt || a.entry.key.localeCompare(b.entry.key))
    const keep = new Set(projectRows.slice(0, this.maxRecords).map(({ entry }) => entry.key))
    await Promise.all(valid
      .filter(({ record, entry }) => record!.projectID === projectID && !keep.has(entry.key))
      .map(({ entry }) => this.storage.remove(entry.key)))
  }
}
