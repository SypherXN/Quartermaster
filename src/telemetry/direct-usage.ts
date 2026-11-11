import { setImmediate as yieldToHost } from "node:timers/promises"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type { Schema } from "effect"
import { frozenApiCost } from "./costs.ts"
import { asApiPrice, asFrozenCost } from "./ledger.ts"
import type { CatalogPrice } from "./prices.ts"
import type { ApiPriceSnapshot, FrozenApiCost, TokenTelemetryRecord } from "./types.ts"

const PREFIX = "quartermaster:direct-usage:v1:"
// Read-only: daily rollups written before lifetime rows existed.
const ROLLUP_PREFIX = "quartermaster:direct-usage:rollup:v1:"
const LIFETIME_PREFIX = "quartermaster:direct-usage:lifetime:v1:"
const TOMBSTONE_PREFIX = "quartermaster:direct-usage:tombstone:v1:"
const FOLD_JOURNAL_KEY = "quartermaster:direct-usage:fold-journal:v1"
const FOLD_BATCH = 1_000
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
  // Frozen API cost accumulated when rows leave the raw window. Absent on rows
  // written before snapshots existed: those records stay historical-unknown.
  apiCost?: FrozenApiCost
  apiRecords?: number
  apiUnknownRecords?: number
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
  // Frozen at the first durable write. Absent means historical-unknown; an
  // explicit source "unavailable" or empty catalog is a known unpriced call.
  apiPrice?: ApiPriceSnapshot
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

// Same suffix as the raw key, so a folded call cannot be written again.
const tombstoneKey = (rawKey: string) => `${TOMBSTONE_PREFIX}${rawKey.slice(PREFIX.length)}`

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

type DirectApiFields = Pick<DirectUsageRollupSlice, "apiCost" | "apiRecords" | "apiUnknownRecords">

// Coverage is all-or-nothing once present: a legacy slice keeps every field
// absent, and a written row must account for each record as priced or unknown.
function asDirectApiFields(value: Partial<DirectUsageRollupSlice>): DirectApiFields | undefined {
  const rawCost = value.apiCost
  const apiCost = rawCost === undefined ? undefined : asFrozenCost(rawCost)
  if (rawCost !== undefined && apiCost === undefined) return undefined
  const apiRecords = value.apiRecords
  const apiUnknownRecords = value.apiUnknownRecords
  if (apiRecords !== undefined && !count(apiRecords)) return undefined
  if (apiUnknownRecords !== undefined && !count(apiUnknownRecords)) return undefined
  if (apiUnknownRecords !== undefined && apiRecords === undefined) return undefined
  if (apiRecords !== undefined &&
    (apiUnknownRecords === undefined || apiRecords + apiUnknownRecords !== value.records)) return undefined
  if (apiRecords !== undefined && apiRecords > 0 && apiCost === undefined) return undefined
  if (apiCost !== undefined && apiRecords === undefined) return undefined
  if (apiCost !== undefined && apiCost.pricedRecords + apiCost.unpricedRecords !== apiRecords) return undefined
  return {
    ...(apiCost === undefined ? {} : { apiCost }),
    ...(apiRecords === undefined ? {} : { apiRecords }),
    ...(apiUnknownRecords === undefined ? {} : { apiUnknownRecords }),
  }
}

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
  const api = asDirectApiFields(slice)
  if (!api) return undefined
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
    ...api,
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

interface DirectFoldJournal {
  version: 1
  targets: Array<{ key: string; row: DirectUsageLifetime }>
  rawKeys: string[]
  tombstones: string[]
}

function asJournal(value: unknown): DirectFoldJournal | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const journal = value as Partial<DirectFoldJournal>
  if (journal.version !== 1 || !Array.isArray(journal.targets) || !Array.isArray(journal.rawKeys) ||
    !Array.isArray(journal.tombstones) || journal.rawKeys.length > FOLD_BATCH ||
    journal.tombstones.length > FOLD_BATCH || journal.targets.length === 0 ||
    journal.targets.length > FOLD_BATCH || journal.rawKeys.length === 0 ||
    journal.rawKeys.length !== journal.tombstones.length) return undefined
  const targets: DirectFoldJournal["targets"] = []
  const targetKeys = new Set<string>()
  for (const target of journal.targets) {
    if (typeof target !== "object" || target === null || typeof target.key !== "string" ||
      !target.key.startsWith(LIFETIME_PREFIX)) return undefined
    const row = asLifetime(target.row)
    if (!row || target.key !== lifetimeKey(row.projectID, row) || targetKeys.has(target.key)) return undefined
    targetKeys.add(target.key)
    targets.push({ key: target.key, row })
  }
  const rawKeys = new Set<string>()
  const tombstones = new Set<string>()
  for (let index = 0; index < journal.rawKeys.length; index++) {
    const rawKey = journal.rawKeys[index]
    const marker = journal.tombstones[index]
    if (typeof rawKey !== "string" || !rawKey.startsWith(PREFIX) || typeof marker !== "string" ||
      marker !== tombstoneKey(rawKey) || rawKeys.has(rawKey) || tombstones.has(marker)) return undefined
    let identity: unknown[]
    try {
      const parsed = JSON.parse(decodeURIComponent(rawKey.slice(PREFIX.length)))
      if (!Array.isArray(parsed) || parsed.length !== 3) return undefined
      identity = parsed
    } catch {
      return undefined
    }
    const [projectID, pluginID, usageID] = identity
    const project = id(projectID, MAX_MODEL) ? projectID as string : undefined
    const plugin = id(pluginID, MAX_ID) ? pluginID as string : undefined
    const usage = id(usageID, MAX_ID) ? usageID as string : undefined
    if (!project || !plugin || !usage ||
      keyFor({ projectID: project, pluginID: plugin, usageID: usage }) !== rawKey) return undefined
    rawKeys.add(rawKey)
    tombstones.add(marker)
  }
  return { version: 1, targets, rawKeys: [...rawKeys], tombstones: [...tombstones] }
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
  const apiPrice = item.apiPrice === undefined ? undefined : asApiPrice(item.apiPrice)
  if (item.apiPrice !== undefined && apiPrice === undefined) return undefined
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
    ...(apiPrice === undefined ? {} : { apiPrice }),
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

/**
 * Per-call frozen API cost. Undefined only when the call predates snapshots;
 * an explicitly unavailable or empty snapshot is a known unpriced cost.
 */
export function directUsageApiCost(record: DirectUsageRecord): FrozenApiCost | undefined {
  if (!record.apiPrice) return undefined
  // The frozen-cost arithmetic only reads these fields; no host identity needed.
  return frozenApiCost({
    apiPrice: record.apiPrice,
    providerID: record.providerID,
    modelID: record.modelID,
    counts: record.counts,
    partial: record.partial,
    usageStatus: "reported",
  } as unknown as TokenTelemetryRecord)
}

function addFrozenApiCost(row: DirectUsageLifetime, record: DirectUsageRecord): void {
  // A row folded before snapshots existed has no coverage yet: count its
  // existing records as historical-unknown before adding this batch's record.
  if (row.apiRecords === undefined && row.apiUnknownRecords === undefined && row.records > 0) {
    row.apiUnknownRecords = row.records
  } else if (row.apiRecords !== undefined && row.apiUnknownRecords === undefined) {
    row.apiUnknownRecords = Math.max(0, row.records - row.apiRecords)
  }
  row.apiRecords ??= 0
  row.apiUnknownRecords ??= 0
  const cost = directUsageApiCost(record)
  if (!cost) {
    const next = row.apiUnknownRecords + 1
    if (!Number.isSafeInteger(next)) throw new Error("Direct lifetime API count overflow")
    row.apiUnknownRecords = next
    return
  }
  const total: FrozenApiCost = row.apiCost ?? {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0,
    pricedRecords: 0, unpricedRecords: 0, partialRecords: 0, cacheUnpricedRecords: 0,
  }
  const addMoney = (sum: number, value: number) => {
    const next = sum + value
    if (!Number.isFinite(next) || next < 0) throw new Error("Direct lifetime API cost overflow")
    return next
  }
  const addCount = (sum: number, value: number) => {
    const next = sum + value
    if (!Number.isSafeInteger(next) || next < 0) throw new Error("Direct lifetime API count overflow")
    return next
  }
  total.input = addMoney(total.input, cost.input)
  total.output = addMoney(total.output, cost.output)
  total.cacheRead = addMoney(total.cacheRead, cost.cacheRead)
  total.cacheWrite = addMoney(total.cacheWrite, cost.cacheWrite)
  total.total = addMoney(total.total, cost.total)
  total.pricedRecords = addCount(total.pricedRecords, cost.pricedRecords)
  total.unpricedRecords = addCount(total.unpricedRecords, cost.unpricedRecords)
  total.partialRecords = addCount(total.partialRecords, cost.partialRecords)
  total.cacheUnpricedRecords = addCount(total.cacheUnpricedRecords, cost.cacheUnpricedRecords)
  total.pricedTokens = addCount(total.pricedTokens ?? 0, cost.pricedTokens ?? 0)
  total.unpricedTokens = addCount(total.unpricedTokens ?? 0, cost.unpricedTokens ?? 0)
  total.unknownTokenRecords = addCount(total.unknownTokenRecords ?? 0, cost.unknownTokenRecords ?? 0)
  row.apiCost = total
  row.apiRecords = addCount(row.apiRecords ?? 0, 1)
}

export interface DirectUsageLedgerOptions {
  now?: () => number
  retentionMs?: number
  /** Resolve a model's API price table once, before the first durable write. */
  apiPrice?: (providerID: string, modelID: string) => Promise<readonly CatalogPrice[] | null | undefined>
}

export class DirectUsageLedger {
  private pending = Promise.resolve()
  // Per instance: first activity after startup, then at most once per 24 hours.
  private lastPrunedAt: number | undefined
  private readonly storage: StorageDomain
  private readonly now: () => number
  private readonly retentionMs: number
  private readonly apiPrice?: DirectUsageLedgerOptions["apiPrice"]

  constructor(storage: StorageDomain, now?: () => number, retentionMs?: number)
  constructor(storage: StorageDomain, options?: DirectUsageLedgerOptions)
  constructor(
    storage: StorageDomain,
    nowOrOptions: (() => number) | DirectUsageLedgerOptions = Date.now,
    retentionMs = RETENTION_MS,
  ) {
    const options = typeof nowOrOptions === "function" ? { now: nowOrOptions, retentionMs } : nowOrOptions
    this.storage = storage
    this.now = options.now ?? Date.now
    this.retentionMs = Math.max(1, options.retentionMs ?? RETENTION_MS)
    this.apiPrice = options.apiPrice
  }

  record(input: DirectUsageInput): Promise<{ replaced: boolean }> {
    const write = this.pending.catch(() => {}).then(async () => {
      await this.recoverLocked()
      const key = keyFor({ projectID: input.projectID, pluginID: input.pluginID, usageID: input.usageID })
      // A call already folded into lifetime is never written again.
      if ((await this.storage.get(tombstoneKey(key))) !== undefined) return { replaced: true }
      const existingValue = await this.storage.get(key)
      let existing: DirectUsageRecord | undefined
      if (existingValue !== undefined) {
        existing = asRecord(existingValue)
        if (!existing) throw new Error("Malformed direct usage record")
      }
      const record = directUsageFromInput(input, existing?.reportedAt ?? this.now())
      if (existing && (existing.projectID !== record.projectID || existing.pluginID !== record.pluginID || existing.usageID !== record.usageID)) {
        throw new TypeError("Invalid direct usage report")
      }
      // First durable save freezes the price. A revision or restart keeps it.
      const apiPrice = existing ? existing.apiPrice : await this.captureApiPrice(record)
      const stored = apiPrice === undefined ? record : { ...record, apiPrice }
      await this.storage.set(key, stored as unknown as Schema.Json)
      await this.prune()
      return { replaced: existing !== undefined }
    })
    this.pending = write.then(() => {}, () => {})
    return write
  }

  async list(projectID?: string): Promise<DirectUsageRecord[]> {
    return this.serialize(async () => {
      await this.prune()
      return this.readRecords(projectID)
    })
  }

  // Legacy daily rollups, written before lifetime rows existed. Never written now.
  async listRollups(projectID?: string): Promise<DirectUsageRollup[]> {
    return this.serialize(async () => {
      await this.recoverLocked()
      return this.readRollups(projectID)
    })
  }

  async listLifetime(projectID?: string): Promise<DirectUsageLifetime[]> {
    return this.serialize(async () => {
      await this.recoverLocked()
      return this.readLifetime(projectID)
    })
  }

  /** One consistent raw/rollup/lifetime snapshot after recovery and pruning. */
  async snapshot(projectID?: string) {
    return this.serialize(async () => {
      await this.prune()
      return {
        records: await this.readRecords(projectID),
        rollups: await this.readRollups(projectID),
        lifetime: await this.readLifetime(projectID),
      }
    })
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
      await yieldToHost()
    }
  }

  private async readRecords(projectID?: string): Promise<DirectUsageRecord[]> {
    const entries = await this.scan()
    // Keep pending expiry visible until it is folded, so All never loses usage.
    return entries
      .map((entry) => ({ entry, record: asRecord(entry.value) }))
      .filter(({ entry, record }) => record !== undefined && entry.key === keyFor(record))
      .map(({ record }) => record!)
      .filter((record) => projectID === undefined || record.projectID === projectID)
      .sort((a, b) => a.reportedAt - b.reportedAt || a.usageID.localeCompare(b.usageID))
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
  private async readLifetime(projectID?: string): Promise<DirectUsageLifetime[]> {
    const entries = await this.scan(LIFETIME_PREFIX)
    return entries
      .map((entry) => ({ entry, row: asLifetime(entry.value) }))
      .filter(({ entry, row }) => row !== undefined && entry.key === lifetimeKey(row.projectID, row))
      .map(({ row }) => row!)
      .filter((row) => projectID === undefined || row.projectID === projectID)
      .sort((a, b) => a.pluginID.localeCompare(b.pluginID) || a.pluginName.localeCompare(b.pluginName) ||
        a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID) ||
        (a.variant ?? "").localeCompare(b.variant ?? ""))
  }

  // Folding is destructive, so any malformed stored row fails closed instead of
  // being replaced with a row that forgets its money.
  private async loadLifetimeForFold(): Promise<Map<string, DirectUsageLifetime>> {
    const stored = new Map<string, DirectUsageLifetime>()
    for (const entry of await this.scan(LIFETIME_PREFIX)) {
      const row = asLifetime(entry.value)
      if (!row || entry.key !== lifetimeKey(row.projectID, row)) throw new Error("Malformed direct usage lifetime row")
      stored.set(entry.key, row)
    }
    return stored
  }

  private async captureApiPrice(record: DirectUsageRecord): Promise<ApiPriceSnapshot | undefined> {
    if (!this.apiPrice) return undefined
    const recordedAt = this.now()
    try {
      const prices = await this.apiPrice(record.providerID, record.modelID)
      const snapshot = asApiPrice({ recordedAt, source: "catalog", prices: prices ? [...prices] : [] })
      return snapshot ?? asApiPrice({ recordedAt, source: "unavailable", prices: [] })
    } catch {
      return asApiPrice({ recordedAt, source: "unavailable", prices: [] })
    }
  }

  /**
   * Finish a journaled fold before any mutation or read. Targets are absolute
   * lifetime replacements, so replaying the journal is idempotent.
   *
   * ponytail: single active writer per storage domain, like the token ledger.
   * A multi-process host needs a CAS/lease on the journal.
   */
  private async recoverLocked(): Promise<void> {
    const value = await this.storage.get(FOLD_JOURNAL_KEY)
    if (value === undefined) return
    const journal = asJournal(value)
    if (!journal) throw new Error("Malformed direct usage fold journal")
    await this.applyJournal(journal)
  }

  // Targets are absolute lifetime replacements, so replay is idempotent.
  private async applyJournal(journal: DirectFoldJournal): Promise<void> {
    for (const target of journal.targets) {
      await this.storage.set(target.key, target.row as unknown as Schema.Json)
    }
    for (const marker of journal.tombstones) {
      await this.storage.set(marker, { version: 1 } as unknown as Schema.Json)
    }
    for (const key of journal.rawKeys) await this.storage.remove(key)
    await this.storage.remove(FOLD_JOURNAL_KEY)
  }

  // One row per plugin, model, and variant, all-time. A call that leaves the raw
  // window lands here; the journal and tombstone make that exactly once.
  private async foldLifetime(records: readonly DirectUsageRecord[]): Promise<void> {
    if (records.length === 0) return
    const stored = await this.loadLifetimeForFold()
    for (let offset = 0; offset < records.length; offset += FOLD_BATCH) {
      const batch = records.slice(offset, offset + FOLD_BATCH)
      if (!batch.length) continue
      const touched = new Set<string>()
      for (const record of batch) {
        const key = lifetimeKey(record.projectID, record)
        const row = stored.get(key) ?? { projectID: record.projectID, ...emptySlice(record) }
        addFrozenApiCost(row, record)
        addToSlice(row, record)
        stored.set(key, row)
        touched.add(key)
      }
      const journal: DirectFoldJournal = {
        version: 1,
        targets: [...touched].map((key) => ({ key, row: stored.get(key)! })),
        rawKeys: batch.map((record) => keyFor(record)),
        tombstones: batch.map((record) => tombstoneKey(keyFor(record))),
      }
      const checked = asJournal(journal)
      if (!checked) throw new Error("Invalid direct usage fold journal")
      await this.storage.set(FOLD_JOURNAL_KEY, checked as unknown as Schema.Json)
      await this.applyJournal(checked)
    }
  }

  // Age only. Every call inside the window is kept, so a range filter is exact.
  private async prune(): Promise<void> {
    await this.recoverLocked()
    const now = this.now()
    if (this.lastPrunedAt !== undefined && now - this.lastPrunedAt < DAY_MS) return
    const cutoff = now - this.retentionMs
    const expired: DirectUsageRecord[] = []
    const invalid: string[] = []
    for (const entry of await this.scan()) {
      const record = asRecord(entry.value)
      if (record && entry.key === keyFor(record)) {
        if (record.reportedAt < cutoff) expired.push(record)
        continue
      }
      const value = entry.value
      // Never delete a row whose money may still be recoverable by a later fix.
      if (typeof value === "object" && value !== null && "apiPrice" in value) {
        throw new Error("Malformed direct usage record api price")
      }
      invalid.push(entry.key)
    }
    await this.foldLifetime(expired)
    for (const key of invalid) await this.storage.remove(key)
    this.lastPrunedAt = now
  }
}
