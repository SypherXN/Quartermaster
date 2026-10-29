import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type { Schema } from "effect"

const PREFIX = "quartermaster:direct-usage:v1:"
// Read-only: daily rollups written before lifetime rows existed.
const ROLLUP_PREFIX = "quartermaster:direct-usage:rollup:v1:"
const LIFETIME_PREFIX = "quartermaster:direct-usage:lifetime:v1:"
const DAY_MS = 86_400_000
const RETENTION_MS = 90 * DAY_MS
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

// One plugin and model inside a day's pruned direct calls. usageID is not kept.
// unknownCacheRecords counts partial calls, whose missing cache was stored as zero.
export interface DirectUsageRollupSlice {
  pluginID: string
  pluginName: string
  providerID: string
  modelID: string
  variant: string | null
  records: number
  observedTokens: number
  unknownTokenRecords: number
  partialRecords: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  unknownCacheRecords: number
}

// Pruned rows keep daily counts so the direct-usage total survives the raw
// window. slices keeps the plugin and model. A rollup written before slices
// existed still counts in the day total only. usageID is not kept.
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
  slices: DirectUsageRollupSlice[]
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

// One all-time combination for a project, pruned from the raw direct calls.
export interface DirectUsageLifetime extends DirectUsageRollupSlice {
  projectID: string
}

const lifetimeKey = (
  projectID: string,
  item: Pick<DirectUsageRollupSlice, "pluginID" | "providerID" | "modelID" | "variant">,
) => `${LIFETIME_PREFIX}${encodeURIComponent(JSON.stringify([
  projectID, item.pluginID, item.providerID, item.modelID, item.variant,
]))}`

const id = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value

const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const addCount = (sum: number, value: number) =>
  count(value) && Number.isSafeInteger(sum + value) ? sum + value : sum

function asDirectSlice(value: unknown): DirectUsageRollupSlice | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const slice = value as Partial<DirectUsageRollupSlice>
  if (
    !id(slice.pluginID, MAX_ID) || !id(slice.pluginName, MAX_ID) || !id(slice.providerID, MAX_MODEL) ||
    !id(slice.modelID, MAX_MODEL) || (slice.variant !== null && !id(slice.variant, MAX_ID)) ||
    !count(slice.records) || !count(slice.observedTokens) || !count(slice.unknownTokenRecords) ||
    !count(slice.partialRecords) || !count(slice.input) || !count(slice.output) ||
    !count(slice.cacheRead) || !count(slice.cacheWrite) || !count(slice.reasoning) ||
    !count(slice.unknownCacheRecords)
  ) return undefined
  return {
    pluginID: slice.pluginID!,
    pluginName: slice.pluginName!,
    providerID: slice.providerID!,
    modelID: slice.modelID!,
    variant: slice.variant!,
    records: slice.records!,
    observedTokens: slice.observedTokens!,
    unknownTokenRecords: slice.unknownTokenRecords!,
    partialRecords: slice.partialRecords!,
    input: slice.input!,
    output: slice.output!,
    cacheRead: slice.cacheRead!,
    cacheWrite: slice.cacheWrite!,
    reasoning: slice.reasoning!,
    unknownCacheRecords: slice.unknownCacheRecords!,
  }
}

function asRollup(value: unknown): DirectUsageRollup | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const rollup = value as Partial<DirectUsageRollup>
  if (
    !id(rollup.projectID, MAX_MODEL) || !count(rollup.day) || !count(rollup.records) ||
    !count(rollup.observedTokens) || !count(rollup.unknownTokenRecords) || !count(rollup.partialRecords) ||
    !count(rollup.input) || !count(rollup.output) || !count(rollup.cacheRead) ||
    !count(rollup.cacheWrite) || !count(rollup.reasoning)
  ) return undefined
  let slices: DirectUsageRollupSlice[] = []
  if (rollup.slices !== undefined) {
    if (!Array.isArray(rollup.slices)) return undefined
    const parsed = rollup.slices.map((item) => asDirectSlice(item))
    if (parsed.some((item) => item === undefined)) return undefined
    slices = parsed as DirectUsageRollupSlice[]
  }
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
    slices,
  }
}

function asLifetime(value: unknown): DirectUsageLifetime | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const projectID = (value as { projectID?: unknown }).projectID
  if (!id(projectID, MAX_MODEL)) return undefined
  const slice = asDirectSlice(value)
  if (!slice) return undefined
  return { projectID: projectID as string, ...slice }
}

function emptySlice(record: DirectUsageRecord): DirectUsageRollupSlice {
  return {
    pluginID: record.pluginID,
    pluginName: record.pluginName,
    providerID: record.providerID,
    modelID: record.modelID,
    variant: record.variant,
    records: 0,
    observedTokens: 0,
    unknownTokenRecords: 0,
    partialRecords: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    unknownCacheRecords: 0,
  }
}

// The one place a call's counters are added, shared by both folds.
function addToSlice(slice: DirectUsageRollupSlice, record: DirectUsageRecord): void {
  const total = record.counts.input + record.counts.output
  const known = Number.isSafeInteger(total) && total >= 0 && Number.isSafeInteger(slice.observedTokens + total)
  if (Number.isSafeInteger(slice.records + 1)) slice.records += 1
  if (known) slice.observedTokens += total
  else if (Number.isSafeInteger(slice.unknownTokenRecords + 1)) slice.unknownTokenRecords += 1
  if (record.partial && Number.isSafeInteger(slice.partialRecords + 1)) slice.partialRecords += 1
  slice.input = addCount(slice.input, record.counts.input)
  slice.output = addCount(slice.output, record.counts.output)
  slice.cacheRead = addCount(slice.cacheRead, record.counts.cacheRead)
  slice.cacheWrite = addCount(slice.cacheWrite, record.counts.cacheWrite)
  slice.reasoning = addCount(slice.reasoning, record.counts.reasoning)
  if (record.partial && Number.isSafeInteger(slice.unknownCacheRecords + 1)) slice.unknownCacheRecords += 1
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
  // Per instance: first activity after startup, then at most once per 24 hours.
  private lastPrunedAt: number | undefined
  private readonly storage: StorageDomain
  private readonly now: () => number
  private readonly retentionMs: number

  constructor(storage: StorageDomain, now: () => number = Date.now, retentionMs = RETENTION_MS) {
    this.storage = storage
    this.now = now
    this.retentionMs = Math.max(1, retentionMs)
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
      await this.prune()
      return { replaced: existing !== undefined }
    })
    this.pending = write.then(() => {}, () => {})
    return write
  }

  async list(projectID: string): Promise<DirectUsageRecord[]> {
    await this.serialize(() => this.prune())
    const entries = await this.scan()
    // Keep pending expiry visible until it is folded, so All never loses usage.
    return entries
      .map((entry) => ({ entry, record: asRecord(entry.value) }))
      .filter(({ entry, record }) => record !== undefined && entry.key === keyFor(record))
      .map(({ record }) => record!)
      .filter((record) => record.projectID === projectID)
      .sort((a, b) => a.reportedAt - b.reportedAt || a.usageID.localeCompare(b.usageID))
  }

  // Legacy daily rollups, written before lifetime rows existed. Never written now.
  async listRollups(projectID: string): Promise<DirectUsageRollup[]> {
    return this.serialize(() => this.readRollups(projectID))
  }

  async listLifetime(projectID: string): Promise<DirectUsageLifetime[]> {
    return this.serialize(async () => (await this.readLifetime())
      .filter((row) => row.projectID === projectID)
      .sort((a, b) => a.pluginID.localeCompare(b.pluginID) || a.pluginName.localeCompare(b.pluginName) ||
        a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID) ||
        (a.variant ?? "").localeCompare(b.variant ?? "")))
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

  // One row per plugin, model, and variant, all-time, for this project.
  private async readLifetime(): Promise<DirectUsageLifetime[]> {
    const entries = await this.scan(LIFETIME_PREFIX)
    return entries
      .map((entry) => ({ entry, row: asLifetime(entry.value) }))
      .filter(({ entry, row }) => row !== undefined && entry.key === lifetimeKey(row.projectID, row))
      .map(({ row }) => row!)
  }

  private async foldLifetime(records: readonly DirectUsageRecord[]): Promise<void> {
    if (records.length === 0) return
    const stored = new Map((await this.readLifetime()).map((row) => [lifetimeKey(row.projectID, row), row] as const))
    const dirty = new Set<string>()
    for (const record of records) {
      const key = lifetimeKey(record.projectID, record)
      const row = stored.get(key) ?? { projectID: record.projectID, ...emptySlice(record) }
      addToSlice(row, record)
      stored.set(key, row)
      dirty.add(key)
    }
    await Promise.all([...dirty].map((key) => this.storage.set(key, stored.get(key)! as unknown as Schema.Json)))
  }

  // Age only. Every call inside the window is kept, so a range filter is exact.
  private async prune(): Promise<void> {
    const now = this.now()
    if (this.lastPrunedAt !== undefined && now - this.lastPrunedAt < DAY_MS) return
    const cutoff = now - this.retentionMs
    const entries = await this.scan()
    const expired = entries
      .map((entry) => ({ entry, record: asRecord(entry.value) }))
      .filter(({ entry, record }) => record === undefined || (entry.key === keyFor(record) && record.reportedAt < cutoff))
    await this.foldLifetime(expired.flatMap(({ entry, record }) =>
      record && entry.key === keyFor(record) ? [record] : []))
    await Promise.all(expired.map(({ entry }) => this.storage.remove(entry.key)))
    this.lastPrunedAt = now
  }
}
