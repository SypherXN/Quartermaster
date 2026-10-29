import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type { Schema } from "effect"

const PREFIX = "quartermaster:direct-usage:v1:"
const ROLLUP_PREFIX = "quartermaster:direct-usage:rollup:v1:"
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

// Pruned rows keep daily counts so the direct-usage total survives the raw
// window. Plugin, model, and usage id are not kept.
export interface DirectUsageRollup {
  projectID: string
  day: number
  records: number
  observedTokens: number
  unknownTokenRecords: number
  partialRecords: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
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

const rollupKey = (projectID: string, day: number) =>
  `${ROLLUP_PREFIX}${encodeURIComponent(JSON.stringify(projectID))}:${day}`

const id = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value

const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const addCount = (sum: number, value: number) =>
  count(value) && Number.isSafeInteger(sum + value) ? sum + value : sum

function asRollup(value: unknown): DirectUsageRollup | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const rollup = value as Partial<DirectUsageRollup>
  if (
    !id(rollup.projectID, MAX_MODEL) || !count(rollup.day) || !count(rollup.records) ||
    !count(rollup.observedTokens) || !count(rollup.unknownTokenRecords) || !count(rollup.partialRecords) ||
    !count(rollup.input) || !count(rollup.output) || !count(rollup.cacheRead) ||
    !count(rollup.cacheWrite) || !count(rollup.reasoning)
  ) return undefined
  return {
    projectID: rollup.projectID!,
    day: rollup.day!,
    records: rollup.records!,
    observedTokens: rollup.observedTokens!,
    unknownTokenRecords: rollup.unknownTokenRecords!,
    partialRecords: rollup.partialRecords!,
    input: rollup.input!,
    output: rollup.output!,
    cacheRead: rollup.cacheRead!,
    cacheWrite: rollup.cacheWrite!,
    reasoning: rollup.reasoning!,
  }
}

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

  async listRollups(projectID: string): Promise<DirectUsageRollup[]> {
    return this.serialize(() => this.readRollups(projectID))
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.catch(() => {}).then(operation)
    this.pending = task.then(() => {}, () => {})
    return task
  }

  private async scan(prefix = PREFIX) {
    const entries: Awaited<ReturnType<StorageDomain["scan"]>>["entries"][number][] = []
    let after: string | undefined
    while (true) {
      const page = await this.storage.scan({ prefix, after, limit: PAGE_SIZE })
      entries.push(...page.entries)
      if (!page.next || page.next === after) return entries
      after = page.next
    }
  }

  private async readRollups(projectID?: string): Promise<DirectUsageRollup[]> {
    const entries = await this.scan(ROLLUP_PREFIX)
    return entries
      .map((entry) => ({ entry, rollup: asRollup(entry.value) }))
      .filter(({ entry, rollup }) => rollup !== undefined && entry.key === rollupKey(rollup.projectID, rollup.day))
      .map(({ rollup }) => rollup!)
      .filter((rollup) => projectID === undefined || rollup.projectID === projectID)
      .sort((a, b) => a.day - b.day || a.projectID.localeCompare(b.projectID))
  }

  private async archive(records: readonly DirectUsageRecord[]): Promise<void> {
    if (records.length === 0) return
    const stored = new Map((await this.readRollups()).map((rollup) => [rollupKey(rollup.projectID, rollup.day), rollup] as const))
    const dirty = new Set<string>()
    for (const record of records) {
      const day = Math.floor(record.reportedAt / DAY_MS) * DAY_MS
      const key = rollupKey(record.projectID, day)
      const rollup = stored.get(key) ?? {
        projectID: record.projectID, day, records: 0, observedTokens: 0, unknownTokenRecords: 0,
        partialRecords: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
      }
      const total = record.counts.input + record.counts.output
      const known = Number.isSafeInteger(total) && total >= 0 && Number.isSafeInteger(rollup.observedTokens + total)
      if (Number.isSafeInteger(rollup.records + 1)) rollup.records += 1
      if (known) rollup.observedTokens += total
      else if (Number.isSafeInteger(rollup.unknownTokenRecords + 1)) rollup.unknownTokenRecords += 1
      if (record.partial && Number.isSafeInteger(rollup.partialRecords + 1)) rollup.partialRecords += 1
      rollup.input = addCount(rollup.input, record.counts.input)
      rollup.output = addCount(rollup.output, record.counts.output)
      rollup.cacheRead = addCount(rollup.cacheRead, record.counts.cacheRead)
      rollup.cacheWrite = addCount(rollup.cacheWrite, record.counts.cacheWrite)
      rollup.reasoning = addCount(rollup.reasoning, record.counts.reasoning)
      stored.set(key, rollup)
      dirty.add(key)
    }
    await Promise.all([...dirty].map((key) => this.storage.set(key, stored.get(key)! as unknown as Schema.Json)))
  }

  private async prune(projectID: string): Promise<void> {
    const entries = await this.scan()
    const cutoff = this.now() - this.retentionMs
    const valid = entries.map((entry) => ({ entry, record: asRecord(entry.value) }))
      .filter(({ entry, record }) => record !== undefined && entry.key === keyFor(record))
    const projectRows = valid.filter(({ record }) => record!.projectID === projectID && record!.reportedAt >= cutoff)
      .sort((a, b) => b.record!.reportedAt - a.record!.reportedAt || a.entry.key.localeCompare(b.entry.key))
    const keep = new Set(projectRows.slice(0, this.maxRecords).map(({ entry }) => entry.key))
    const removed = valid.filter(({ record, entry }) => record!.projectID === projectID && !keep.has(entry.key))
    await this.archive(removed.map(({ record }) => record!))
    await Promise.all(removed.map(({ entry }) => this.storage.remove(entry.key)))
  }
}
