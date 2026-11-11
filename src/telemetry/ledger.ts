import { setImmediate as yieldToHost } from "node:timers/promises"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type { Schema } from "effect"
import type { TokenTelemetryRecord, ApiPriceSnapshot, FrozenApiCost } from "./types.ts"
import type { CatalogPrice } from "./prices.ts"
import { frozenApiCost } from "./costs.ts"

const PREFIX = "quartermaster:telemetry:v1:"
// Read-only: daily rollups written before lifetime rows existed.
const ROLLUP_PREFIX = "quartermaster:telemetry:rollup:v1:"
const LIFETIME_PREFIX = "quartermaster:telemetry:lifetime:v1:"
const TOMBSTONE_PREFIX = "quartermaster:telemetry:tombstone:v1:"
const FOLD_JOURNAL_KEY = "quartermaster:telemetry:fold-journal:v1"
const FOLD_BATCH = 1_000
const DAY_MS = 86_400_000
export const TOKEN_LEDGER_RETENTION_MS = 90 * DAY_MS
const PAGE_SIZE = 1_000

// One agent, provider, model, and variant inside a day's pruned rows. Plugin
// identity is not on the step, so it is not here. Sum the cache fields for a
// hit rate; unknownCacheRecords means that rate is incomplete.
export interface TokenRollupSlice {
  agentID: string | null
  providerID: string | null
  modelID: string | null
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
  hostCostUSD: number
  hostCostMissing: number
}

// Pruned records keep their daily counts so a report does not silently lose
// usage older than the raw window. slices keeps the category totals. A rollup
// written before slices existed still counts in the day total only.
export interface TokenRollup {
  projectID: string | null
  day: number
  records: number
  observedTokens: number
  unknownTokenRecords: number
  slices: TokenRollupSlice[]
}

// One all-time combination for a project. Same counters as a daily slice, no
// day: a step past the raw window has no time identity left to filter on.
// The session ids survive the fold so a retired session can still be listed.
export interface TokenLifetime extends TokenRollupSlice {
  projectID: string | null
  hostSessionID: string | null
  parentSessionID: string | null
  // Frozen API costs accumulated when rows leave the raw window.
  apiCost?: FrozenApiCost
  apiRecords?: number
  apiUnknownRecords?: number
}

const sliceIdentity = (item: Pick<TokenRollupSlice, "agentID" | "providerID" | "modelID" | "variant">) =>
  [item.agentID, item.providerID, item.modelID, item.variant]

const lifetimeKey = (
  projectID: string | null,
  item: Pick<TokenRollupSlice, "agentID" | "providerID" | "modelID" | "variant"> &
    Partial<Pick<TokenLifetime, "hostSessionID" | "parentSessionID">>,
) => `${LIFETIME_PREFIX}${encodeURIComponent(JSON.stringify([
  projectID,
  ...sliceIdentity(item),
  item.hostSessionID ?? null,
  item.parentSessionID ?? null,
]))}`

// A raw step names its agent hostAgentID; a stored slice names it agentID.
const identityOf = (record: TokenTelemetryRecord) => ({
  agentID: record.hostAgentID,
  providerID: record.providerID,
  modelID: record.modelID,
  variant: record.variant,
})

const countable = (item: unknown): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= 0

const nonnegative = (item: unknown): item is number => typeof item === "number" && Number.isFinite(item) && item >= 0

export function asApiPrice(value: unknown): ApiPriceSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const snapshot = value as Partial<ApiPriceSnapshot>
  const recordedAt = snapshot.recordedAt
  const source = snapshot.source
  const rawPrices = snapshot.prices
  if (!countable(recordedAt) || (source !== "catalog" && source !== "unavailable") ||
    !Array.isArray(rawPrices) || rawPrices.length > 32 ||
    (source === "unavailable" && rawPrices.length > 0)) return undefined
  const prices: ApiPriceSnapshot["prices"] = []
  for (const row of rawPrices) {
    if (typeof row !== "object" || row === null) return undefined
    const item = row as unknown as Record<string, unknown>
    const input = item.input
    const output = item.output
    const cacheRead = item.cacheRead
    const cacheWrite = item.cacheWrite
    const tierSize = item.tierSize
    if (!nonnegative(input) || !nonnegative(output) || !nonnegative(cacheRead) ||
      !nonnegative(cacheWrite) ||
      !(tierSize === null || (Number.isSafeInteger(tierSize) && (tierSize as number) > 0)) ||
      (item.cacheReadKnown !== undefined && typeof item.cacheReadKnown !== "boolean") ||
      (item.cacheWriteKnown !== undefined && typeof item.cacheWriteKnown !== "boolean")) return undefined
    prices.push({
      tierSize: tierSize as number | null,
      input,
      output,
      cacheRead,
      cacheWrite,
      ...(item.cacheReadKnown === undefined ? {} : { cacheReadKnown: item.cacheReadKnown }),
      ...(item.cacheWriteKnown === undefined ? {} : { cacheWriteKnown: item.cacheWriteKnown }),
    })
  }
  return { recordedAt, source, prices }
}

export function asFrozenCost(value: unknown): FrozenApiCost | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const cost = value as Partial<FrozenApiCost>
  const input = cost.input
  const output = cost.output
  const cacheRead = cost.cacheRead
  const cacheWrite = cost.cacheWrite
  const total = cost.total
  const pricedRecords = cost.pricedRecords
  const unpricedRecords = cost.unpricedRecords
  const partialRecords = cost.partialRecords
  const cacheUnpricedRecords = cost.cacheUnpricedRecords
  const pricedTokens = cost.pricedTokens
  const unpricedTokens = cost.unpricedTokens
  const unknownTokenRecords = cost.unknownTokenRecords
  const currency = (cost as { currency?: unknown }).currency
  if (currency !== undefined && currency !== "USD") return undefined
  if (!nonnegative(input) || !nonnegative(output) || !nonnegative(cacheRead) ||
    !nonnegative(cacheWrite) || !nonnegative(total) ||
    !countable(pricedRecords) || !countable(unpricedRecords) ||
    !countable(partialRecords) || !countable(cacheUnpricedRecords)) return undefined
  if (pricedTokens !== undefined && !countable(pricedTokens)) return undefined
  if (unpricedTokens !== undefined && !countable(unpricedTokens)) return undefined
  if (unknownTokenRecords !== undefined && !countable(unknownTokenRecords)) return undefined
  const totalRecords = pricedRecords + unpricedRecords
  if (!Number.isSafeInteger(totalRecords)) return undefined
  if (unknownTokenRecords !== undefined && unknownTokenRecords > totalRecords) return undefined
  if (partialRecords > totalRecords) return undefined
  if (cacheUnpricedRecords > totalRecords) return undefined
  const sum = input + output + cacheRead + cacheWrite
  if (!Number.isFinite(sum) || Math.abs(sum - total) > 1e-9 * Math.max(1, Math.abs(total))) return undefined
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    pricedRecords,
    unpricedRecords,
    partialRecords,
    cacheUnpricedRecords,
    ...(pricedTokens === undefined ? {} : { pricedTokens }),
    ...(unpricedTokens === undefined ? {} : { unpricedTokens }),
    ...(unknownTokenRecords === undefined ? {} : { unknownTokenRecords }),
  }
}

const nullableName = (item: unknown) => item === null || (typeof item === "string" && item.length > 0)

function asSlice(value: unknown): TokenRollupSlice | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const slice = value as Partial<TokenRollupSlice>
  if (
    !nullableName(slice.agentID) || !nullableName(slice.providerID) || !nullableName(slice.modelID) ||
    !nullableName(slice.variant) || (slice.providerID === null) !== (slice.modelID === null) ||
    !countable(slice.records) || !countable(slice.observedTokens) || !countable(slice.unknownTokenRecords) ||
    !countable(slice.partialRecords) || !countable(slice.input) || !countable(slice.output) ||
    !countable(slice.cacheRead) || !countable(slice.cacheWrite) || !countable(slice.reasoning) ||
    !countable(slice.unknownCacheRecords) || !countable(slice.hostCostMissing) ||
    typeof slice.hostCostUSD !== "number" || !Number.isFinite(slice.hostCostUSD) || slice.hostCostUSD < 0
  ) return undefined
  return {
    agentID: slice.agentID!,
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
    hostCostUSD: slice.hostCostUSD,
    hostCostMissing: slice.hostCostMissing!,
  }
}

function asRollup(value: unknown): TokenRollup | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const rollup = value as Partial<TokenRollup>
  if (rollup.projectID !== null && (typeof rollup.projectID !== "string" || !rollup.projectID)) return undefined
  if (!countable(rollup.day) || !countable(rollup.records) || !countable(rollup.observedTokens) || !countable(rollup.unknownTokenRecords)) {
    return undefined
  }
  let slices: TokenRollupSlice[] = []
  if (rollup.slices !== undefined) {
    if (!Array.isArray(rollup.slices)) return undefined
    const parsed = rollup.slices.map((item) => asSlice(item))
    if (parsed.some((item) => item === undefined)) return undefined
    slices = parsed as TokenRollupSlice[]
  }
  return {
    projectID: rollup.projectID!,
    day: rollup.day!,
    records: rollup.records!,
    observedTokens: rollup.observedTokens!,
    unknownTokenRecords: rollup.unknownTokenRecords!,
    slices,
  }
}

function asLifetime(value: unknown): TokenLifetime | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const projectID = (value as { projectID?: unknown }).projectID
  if (projectID !== null && (typeof projectID !== "string" || !projectID)) return undefined
  const session = value as { hostSessionID?: unknown; parentSessionID?: unknown }
  if (!nullableName(session.hostSessionID) || !nullableName(session.parentSessionID)) return undefined
  const slice = asSlice(value)
  if (!slice) return undefined
  const apiCost = (value as { apiCost?: unknown }).apiCost === undefined
    ? undefined : asFrozenCost((value as { apiCost?: unknown }).apiCost)
  if ((value as { apiCost?: unknown }).apiCost !== undefined && apiCost === undefined) return undefined
  const apiRecords = (value as { apiRecords?: unknown }).apiRecords
  const apiUnknownRecords = (value as { apiUnknownRecords?: unknown }).apiUnknownRecords
  if (apiRecords !== undefined && !countable(apiRecords)) return undefined
  if (apiUnknownRecords !== undefined && !countable(apiUnknownRecords)) return undefined
  if (apiUnknownRecords !== undefined && apiRecords === undefined) return undefined
  if (apiRecords !== undefined && (apiUnknownRecords === undefined || apiRecords + (apiUnknownRecords as number) !== slice.records)) return undefined
  if (apiRecords !== undefined && apiRecords > 0 && apiCost === undefined) return undefined
  if (apiCost !== undefined && apiRecords === undefined) return undefined
  if (apiCost !== undefined && apiCost.pricedRecords + apiCost.unpricedRecords !== (apiRecords as number)) return undefined
  return {
    projectID: projectID as string | null,
    hostSessionID: (session.hostSessionID as string | null | undefined) ?? null,
    parentSessionID: (session.parentSessionID as string | null | undefined) ?? null,
    ...slice,
    ...(apiCost === undefined ? {} : { apiCost }),
    ...(apiRecords === undefined ? {} : { apiRecords: apiRecords as number }),
    ...(apiUnknownRecords === undefined ? {} : { apiUnknownRecords: apiUnknownRecords as number }),
  }
}

function emptySlice(record: TokenTelemetryRecord): TokenRollupSlice {
  return {
    agentID: record.hostAgentID,
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
    hostCostUSD: 0,
    hostCostMissing: 0,
  }
}

function knownTokenTotal(record: TokenTelemetryRecord): number | undefined {
  const counts = record.counts
  if (!counts) return undefined
  const total = counts.input + counts.output
  return Number.isSafeInteger(total) && total >= 0 ? total : undefined
}

// The one place a step's counters are added, so a daily slice and a lifetime
// row can never drift apart.
function addToSlice(slice: TokenRollupSlice, record: TokenTelemetryRecord): void {
  const total = knownTokenTotal(record)
  slice.records += 1
  if (total === undefined || !Number.isSafeInteger(slice.observedTokens + total)) slice.unknownTokenRecords += 1
  else slice.observedTokens += total
  if (record.partial) slice.partialRecords += 1
  const counts = record.counts
  if (counts) {
    slice.input = addStored(slice.input, counts.input)
    slice.output = addStored(slice.output, counts.output)
    slice.cacheRead = addStored(slice.cacheRead, counts.cacheRead)
    slice.cacheWrite = addStored(slice.cacheWrite, counts.cacheWrite)
    slice.reasoning = addStored(slice.reasoning, counts.reasoning)
  }
  if (!knownCacheCounts(record)) slice.unknownCacheRecords += 1
  const hostCost = record.hostCostUSD
  if (typeof hostCost === "number" && Number.isFinite(hostCost) && hostCost >= 0 && Number.isFinite(slice.hostCostUSD + hostCost)) {
    slice.hostCostUSD += hostCost
  } else slice.hostCostMissing += 1
}

function knownCacheCounts(record: TokenTelemetryRecord): boolean {
  if (record.usageStatus !== "reported" || record.partial !== false || !record.counts) return false
  const { cacheRead, cacheWrite } = record.counts
  return Number.isSafeInteger(cacheRead) && cacheRead >= 0 && Number.isSafeInteger(cacheWrite) && cacheWrite >= 0
}

function addStored(sum: number, value: number): number {
  return Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(sum + value) ? sum + value : sum
}

function addFrozenApiCost(row: TokenLifetime, record: TokenTelemetryRecord): void {
  // A row folded before snapshots existed has no api coverage yet: count its
  // existing records as historical-unknown before adding this batch's record.
  if (row.apiRecords === undefined && row.apiUnknownRecords === undefined && row.records > 0) {
    row.apiUnknownRecords = row.records
  } else if (row.apiRecords !== undefined && row.apiUnknownRecords === undefined) {
    row.apiUnknownRecords = Math.max(0, row.records - row.apiRecords)
  }
  row.apiRecords ??= 0
  row.apiUnknownRecords ??= 0
  const cost = frozenApiCost(record)
  if (!cost) {
    row.apiUnknownRecords = (row.apiUnknownRecords ?? 0) + 1
    return
  }
  const total: FrozenApiCost = row.apiCost ?? {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0,
    pricedRecords: 0, unpricedRecords: 0, partialRecords: 0, cacheUnpricedRecords: 0,
  }
  const addMoney = (sum: number, value: number) => {
    const next = sum + value
    if (!Number.isFinite(next) || next < 0) throw new Error("Token lifetime API cost overflow")
    return next
  }
  const addCount = (sum: number, value: number) => {
    const next = sum + value
    if (!Number.isSafeInteger(next) || next < 0) throw new Error("Token lifetime API count overflow")
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

export interface TokenLedgerOptions {
  now?: () => number
  retentionMs?: number
  /** Called with raw records that destructive maintenance removed. */
  onRemove?: (records: readonly TokenTelemetryRecord[]) => void
  /** Resolve a model's API price table once, before the first durable write. */
  apiPrice?: (providerID: string, modelID: string) => Promise<readonly CatalogPrice[] | null | undefined>
}

export interface TokenLedgerQuery {
  projectID?: string | null
  limit?: number
}

function keyFor(id: string) {
  return `${PREFIX}${encodeURIComponent(id)}`
}

function asRecord(value: unknown): TokenTelemetryRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Partial<TokenTelemetryRecord>
  if (
    record.hostContractVersion !== "2.0.18" ||
    (record.sourceEvent !== "session.step.ended" && record.sourceEvent !== "session.step.failed") ||
    typeof record.hostEventID !== "string" || !record.hostEventID ||
    typeof record.hostSessionID !== "string" || !record.hostSessionID ||
    typeof record.hostMessageID !== "string" || !record.hostMessageID ||
    typeof record.completedAt !== "number" || !Number.isFinite(record.completedAt)
  ) return undefined
  const nullableString = (item: unknown) => item === null || (typeof item === "string" && item.length > 0)
  const hostAgentID = record.hostAgentID ?? null
  if (
    !nullableString(record.hostProjectID) || !nullableString(record.parentSessionID) ||
    !nullableString(hostAgentID) ||
    !nullableString(record.providerID) || !nullableString(record.modelID) || !nullableString(record.variant) ||
    (record.providerID === null) !== (record.modelID === null)
  ) return undefined
  const counts = record.counts
  if (counts !== null && (
    !counts || ![counts.input, counts.output, counts.reasoning, counts.cacheRead, counts.cacheWrite]
      .every((item) => typeof item === "number" && Number.isFinite(item))
  )) return undefined
  if (record.usageStatus !== (counts === null ? "missing" : "reported")) return undefined
  const partial = record.partial
  if (partial !== undefined && typeof partial !== "boolean") return undefined
  const hostCostUSD = record.hostCostUSD
  const hostCost = typeof hostCostUSD === "number" && Number.isFinite(hostCostUSD) && hostCostUSD >= 0 ? hostCostUSD : null
  const apiPrice = record.apiPrice === undefined ? undefined : asApiPrice(record.apiPrice)
  if (record.apiPrice !== undefined && apiPrice === undefined) return undefined

  // Rebuild the whitelist so even a malformed stored value cannot export extra fields.
  return {
    hostContractVersion: "2.0.18",
    hostEventID: record.hostEventID,
    sourceEvent: record.sourceEvent,
    hostSessionID: record.hostSessionID,
    hostMessageID: record.hostMessageID,
    hostProjectID: record.hostProjectID!,
    parentSessionID: record.parentSessionID!,
    hostAgentID,
    providerID: record.providerID!,
    modelID: record.modelID!,
    variant: record.variant!,
    completedAt: record.completedAt,
    counts: counts === null ? null : {
      input: counts.input,
      output: counts.output,
      reasoning: counts.reasoning,
      cacheRead: counts.cacheRead,
      cacheWrite: counts.cacheWrite,
    },
    usageStatus: record.usageStatus,
    partial: partial ?? false,
    hostCostUSD: hostCost,
    ...(apiPrice === undefined ? {} : { apiPrice }),
  }
}

async function scanAll(storage: StorageDomain, prefix: string = PREFIX) {
  const entries: Awaited<ReturnType<StorageDomain["scan"]>>["entries"][number][] = []
  let after: string | undefined
  while (true) {
    const page = await storage.scan({ prefix, after, limit: PAGE_SIZE })
    entries.push(...page.entries)
    if (!page.next || page.next === after) return entries
    after = page.next
    await yieldToHost()
  }
}

const tombstoneKey = (hostEventID: string) => `${TOMBSTONE_PREFIX}${encodeURIComponent(hostEventID)}`

interface FoldJournal {
  version: 1
  targets: Array<{ key: string; row: TokenLifetime }>
  rawKeys: string[]
  tombstones: string[]
}

function asJournal(value: unknown): FoldJournal | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const journal = value as Partial<FoldJournal>
  if (journal.version !== 1 || !Array.isArray(journal.targets) || !Array.isArray(journal.rawKeys) ||
    !Array.isArray(journal.tombstones) || journal.rawKeys.length > FOLD_BATCH ||
    journal.tombstones.length > FOLD_BATCH || journal.targets.length === 0 ||
    journal.targets.length > FOLD_BATCH || journal.rawKeys.length === 0 ||
    journal.rawKeys.length !== journal.tombstones.length) return undefined
  const targets: FoldJournal["targets"] = []
  const targetKeys = new Set<string>()
  for (const target of journal.targets) {
    if (typeof target !== "object" || target === null || typeof target.key !== "string" ||
      !target.key.startsWith(LIFETIME_PREFIX)) return undefined
    const row = asLifetime(target.row)
    if (!row || target.key !== lifetimeKey(row.projectID, row) || targetKeys.has(target.key)) return undefined
    if ((row.apiRecords === undefined) !== (row.apiUnknownRecords === undefined)) return undefined
    if (row.apiRecords !== undefined && row.apiRecords + (row.apiUnknownRecords ?? 0) !== row.records) return undefined
    if (row.apiCost && row.apiCost.pricedRecords + row.apiCost.unpricedRecords !== (row.apiRecords ?? 0)) return undefined
    targetKeys.add(target.key)
    targets.push({ key: target.key, row })
  }
  const ids = new Set<string>()
  const rawKeys = new Set<string>()
  for (let index = 0; index < journal.rawKeys.length; index++) {
    const rawKey = journal.rawKeys[index]
    const id = journal.tombstones[index]
    if (typeof rawKey !== "string" || typeof id !== "string" || id.length === 0 ||
      rawKey !== keyFor(id) || ids.has(id) || rawKeys.has(rawKey)) return undefined
    ids.add(id)
    rawKeys.add(rawKey)
  }
  return { version: 1, targets, rawKeys: [...rawKeys], tombstones: [...ids] }
}

export class TokenLedger {
  private pending = Promise.resolve()
  // Per instance: first activity after startup, then at most once per 24 hours.
  private lastPrunedAt: number | undefined
  private readonly storage: StorageDomain
  private readonly now: () => number
  private readonly retentionMs: number
  private readonly onRemove?: (records: readonly TokenTelemetryRecord[]) => void
  private readonly apiPrice?: TokenLedgerOptions["apiPrice"]

  constructor(storage: StorageDomain, options: TokenLedgerOptions = {}) {
    this.storage = storage
    this.now = options.now ?? Date.now
    this.retentionMs = Math.max(1, options.retentionMs ?? TOKEN_LEDGER_RETENTION_MS)
    this.onRemove = options.onRemove
    this.apiPrice = options.apiPrice
  }

  ingest(input: TokenTelemetryRecord): Promise<void> {
    const record = asRecord(input)
    if (!record) return Promise.reject(new TypeError("Invalid token telemetry record"))
    const supplied = input.apiPrice === undefined ? undefined : asApiPrice(input.apiPrice)
    if (input.apiPrice !== undefined && supplied === undefined) {
      return Promise.reject(new TypeError("Invalid token API price snapshot"))
    }

    // Serialized within this instance; the host KV upserts each event key atomically.
    return this.serialize(async () => {
      await this.recoverLocked()
      const key = keyFor(record.hostEventID)
      if ((await this.storage.get(tombstoneKey(record.hostEventID))) !== undefined) return
      const existingValue = await this.storage.get(key)
      let apiPrice: ApiPriceSnapshot | undefined
      if (existingValue !== undefined) {
        const existing = asRecord(existingValue)
        if (!existing) throw new Error("Malformed token record")
        apiPrice = existing.apiPrice
      } else {
        apiPrice = supplied ?? await this.captureApiPrice(record)
      }
      const { apiPrice: _incoming, ...plain } = record
      await this.storage.set(key, (apiPrice === undefined ? plain : { ...plain, apiPrice }) as unknown as Schema.Json)
      await this.pruneLocked()
    })
  }

  async list(query: TokenLedgerQuery = {}): Promise<TokenTelemetryRecord[]> {
    const limit = Math.max(1, Math.floor(query.limit ?? Infinity))
    return this.serialize(async () => {
      await this.pruneLocked()
      return this.readRaw(query, limit)
    })
  }

  // Legacy daily rollups, written before lifetime rows existed. Never written now.
  async listRollups(query: TokenLedgerQuery = {}): Promise<TokenRollup[]> {
    return this.serialize(async () => {
      await this.recoverLocked()
      return this.readRollups(query)
    })
  }

  // Serialized so a fold that a concurrent list triggered is already on disk.
  async listLifetime(query: TokenLedgerQuery = {}): Promise<TokenLifetime[]> {
    return this.serialize(async () => {
      await this.pruneLocked()
      return this.readLifetime(query)
    })
  }

  /** One consistent raw/rollup/lifetime snapshot after recovery and pruning. */
  async snapshot(query: TokenLedgerQuery = {}) {
    const limit = Math.max(1, Math.floor(query.limit ?? Infinity))
    return this.serialize(async () => {
      await this.pruneLocked()
      return {
        records: await this.readRaw(query, limit),
        rollups: await this.readRollups(query),
        lifetime: await this.readLifetime(query),
      }
    })
  }

  // Destructive maintenance: drop every row recorded without a provider. The
  // step-model map is in memory only, so nothing can re-derive the model later;
  // such rows can only ever render as "Unattributed".
  async removeUnattributed(query: TokenLedgerQuery = {}) {
    return this.serialize(async () => {
      await this.recoverLocked()
      const inScope = (projectID: string | null) => query.projectID === undefined || projectID === (query.projectID ?? null)
      const removed = { records: 0, lifetime: 0, rollups: 0, observedTokens: 0 }
      const keys: string[] = []
      const removedRecords: TokenTelemetryRecord[] = []
      for (const { key, value } of await scanAll(this.storage)) {
        const record = asRecord(value)
        if (!record || record.providerID !== null || !inScope(record.hostProjectID)) continue
        keys.push(key)
        removedRecords.push(record)
        removed.records += 1
        removed.observedTokens += knownTokenTotal(record) ?? 0
      }
      for (const { key, value } of await scanAll(this.storage, LIFETIME_PREFIX)) {
        const row = asLifetime(value)
        if (!row || row.providerID !== null || !inScope(row.projectID)) continue
        keys.push(key)
        removed.lifetime += 1
        removed.observedTokens += row.observedTokens
      }
      for (const { key, value } of await scanAll(this.storage, ROLLUP_PREFIX)) {
        const rollup = asRollup(value)
        if (!rollup || !inScope(rollup.projectID)) continue
        const slices = rollup.slices.filter((slice) => slice.providerID !== null)
        if (slices.length === rollup.slices.length) continue
        removed.rollups += 1
        for (const slice of rollup.slices) if (slice.providerID === null) removed.observedTokens += slice.observedTokens
        if (!slices.length) { keys.push(key); continue }
        // Keep the attributed slices; the row's counters are their sums.
        await this.storage.set(key, {
          ...rollup,
          slices,
          records: slices.reduce((sum, slice) => sum + slice.records, 0),
          observedTokens: slices.reduce((sum, slice) => sum + slice.observedTokens, 0),
          unknownTokenRecords: slices.reduce((sum, slice) => sum + slice.unknownTokenRecords, 0),
        } as unknown as Parameters<StorageDomain["set"]>[1])
      }
      await Promise.all(keys.map((key) => this.storage.remove(key)))
      this.onRemove?.(removedRecords)
      return removed
    })
  }

  // Destructive maintenance: drop every row for one project. Used when a host
  // directory is not real usage at all (the reviewer's isolation sandbox).
  async removeProject(projectID: string) {
    return this.serialize(async () => {
      await this.recoverLocked()
      const removed = { records: 0, lifetime: 0, rollups: 0, observedTokens: 0 }
      const removedRecords: TokenTelemetryRecord[] = []
      for (const { key, value } of await scanAll(this.storage)) {
        const record = asRecord(value)
        if (!record || record.hostProjectID !== projectID) continue
        removedRecords.push(record)
        removed.records += 1
        removed.observedTokens += knownTokenTotal(record) ?? 0
        await this.storage.remove(key)
      }
      for (const { key, value } of await scanAll(this.storage, LIFETIME_PREFIX)) {
        const row = asLifetime(value)
        if (!row || row.projectID !== projectID) continue
        removed.lifetime += 1
        removed.observedTokens += row.observedTokens
        await this.storage.remove(key)
      }
      for (const { key, value } of await scanAll(this.storage, ROLLUP_PREFIX)) {
        const rollup = asRollup(value)
        if (!rollup || rollup.projectID !== projectID) continue
        removed.rollups += 1
        removed.observedTokens += rollup.observedTokens
        await this.storage.remove(key)
      }
      this.onRemove?.(removedRecords)
      return removed
    })
  }

  // Destructive maintenance: drop every row whose project the host no longer
  // registers, plus rows that never got one. Nothing can name those projects, so
  // they can only ever render as hash ids or Unattributed.
  async removeUnlisted(known: readonly string[]) {
    return this.serialize(async () => {
      await this.recoverLocked()
      const keep = new Set(known)
      const unbound = (projectID: string | null) => projectID === null || !keep.has(projectID)
      const removed = { records: 0, lifetime: 0, rollups: 0, observedTokens: 0 }
      const removedRecords: TokenTelemetryRecord[] = []
      for (const { key, value } of await scanAll(this.storage)) {
        const record = asRecord(value)
        if (!record || !unbound(record.hostProjectID)) continue
        removedRecords.push(record)
        removed.records += 1
        removed.observedTokens += knownTokenTotal(record) ?? 0
        await this.storage.remove(key)
      }
      for (const { key, value } of await scanAll(this.storage, LIFETIME_PREFIX)) {
        const row = asLifetime(value)
        if (!row || !unbound(row.projectID)) continue
        removed.lifetime += 1
        removed.observedTokens += row.observedTokens
        await this.storage.remove(key)
      }
      for (const { key, value } of await scanAll(this.storage, ROLLUP_PREFIX)) {
        const rollup = asRollup(value)
        if (!rollup || !unbound(rollup.projectID)) continue
        removed.rollups += 1
        removed.observedTokens += rollup.observedTokens
        await this.storage.remove(key)
      }
      this.onRemove?.(removedRecords)
      return removed
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.catch(() => {}).then(operation)
    this.pending = task.then(() => {}, () => {})
    return task
  }

  private async captureApiPrice(record: TokenTelemetryRecord): Promise<ApiPriceSnapshot | undefined> {
    if (!this.apiPrice) return undefined
    const recordedAt = this.now()
    if (!record.providerID || !record.modelID) {
      return asApiPrice({ recordedAt, source: "catalog", prices: [] })
    }
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
   * ponytail: single active writer per storage domain, like the rest of the
   * ledger. A multi-process host needs a CAS/lease on the journal.
   */
  private async recoverLocked(): Promise<void> {
    const value = await this.storage.get(FOLD_JOURNAL_KEY)
    if (value === undefined) return
    const journal = asJournal(value)
    if (!journal) throw new Error("Malformed token fold journal")
    await this.applyJournal(journal)
  }

  private async applyJournal(journal: FoldJournal): Promise<void> {
    for (const target of journal.targets) {
      await this.storage.set(target.key, target.row as unknown as Schema.Json)
    }
    for (const id of journal.tombstones) {
      await this.storage.set(tombstoneKey(id), { version: 1 } as unknown as Schema.Json)
    }
    for (const key of journal.rawKeys) await this.storage.remove(key)
    await this.storage.remove(FOLD_JOURNAL_KEY)
  }

  private async readRaw(query: TokenLedgerQuery = {}, limit = Infinity): Promise<TokenTelemetryRecord[]> {
    const entries = await scanAll(this.storage)
    return entries
      .map((entry) => ({ entry, record: asRecord(entry.value) }))
      .filter(({ entry, record }) => record !== undefined && entry.key === keyFor(record.hostEventID))
      .map(({ record }) => record!)
      .filter((record) => query.projectID === undefined || record.hostProjectID === (query.projectID ?? null))
      .sort((a, b) => a.completedAt - b.completedAt || a.hostEventID.localeCompare(b.hostEventID))
      .slice(-limit)
  }

  private async readRollups(query: TokenLedgerQuery = {}): Promise<TokenRollup[]> {
    const entries = await scanAll(this.storage, ROLLUP_PREFIX)
    return entries
      .map((entry) => asRollup(entry.value))
      .filter((rollup): rollup is TokenRollup => rollup !== undefined)
      .filter((rollup) => query.projectID === undefined || rollup.projectID === (query.projectID ?? null))
      .sort((a, b) => a.day - b.day)
  }

  private async readLifetime(query: TokenLedgerQuery = {}): Promise<TokenLifetime[]> {
    const entries = await scanAll(this.storage, LIFETIME_PREFIX)
    return entries
      .map((entry) => ({ entry, row: asLifetime(entry.value) }))
      .filter(({ entry, row }) => row !== undefined && entry.key === lifetimeKey(row.projectID, row))
      .map(({ row }) => row!)
      .filter((row) => query.projectID === undefined || row.projectID === (query.projectID ?? null))
      .sort((a, b) => (a.agentID ?? "").localeCompare(b.agentID ?? "") ||
        (a.providerID ?? "").localeCompare(b.providerID ?? "") ||
        (a.modelID ?? "").localeCompare(b.modelID ?? "") ||
        (a.variant ?? "").localeCompare(b.variant ?? ""))
  }

  // One row per session, agent, provider, model, and variant, all-time. A step
  // that leaves the raw window lands here; it is never written twice, and the
  // session id is kept so the sessions ledger can still name it.
  private async foldLifetime(records: readonly TokenTelemetryRecord[]): Promise<void> {
    for (let offset = 0; offset < records.length; offset += FOLD_BATCH) {
      const batch = records.slice(offset, offset + FOLD_BATCH)
      if (!batch.length) continue
      const existing = new Map<string, TokenLifetime>()
      for (const record of batch) {
        const session = {
          hostSessionID: record.hostSessionID.length > 0 ? record.hostSessionID : null,
          parentSessionID: record.parentSessionID,
        }
        const key = lifetimeKey(record.hostProjectID, { ...identityOf(record), ...session })
        if (existing.has(key)) continue
        const stored = await this.storage.get(key)
        if (stored === undefined) continue
        const row = asLifetime(stored)
        if (!row || lifetimeKey(row.projectID, row) !== key) throw new Error("Malformed token lifetime row")
        existing.set(key, row)
      }
      const touched = new Set<string>()
      for (const record of batch) {
        const session = {
          hostSessionID: record.hostSessionID.length > 0 ? record.hostSessionID : null,
          parentSessionID: record.parentSessionID,
        }
        const key = lifetimeKey(record.hostProjectID, { ...identityOf(record), ...session })
        const row = existing.get(key) ?? { projectID: record.hostProjectID, ...session, ...emptySlice(record) }
        addFrozenApiCost(row, record)
        addToSlice(row, record)
        existing.set(key, row)
        touched.add(key)
      }
      const targets = [...touched].map((key) => ({ key, row: existing.get(key)! }))
      const journal: FoldJournal = {
        version: 1,
        targets,
        rawKeys: batch.map((record) => keyFor(record.hostEventID)),
        tombstones: batch.map((record) => record.hostEventID),
      }
      const checked = asJournal(journal)
      if (!checked) throw new Error("Invalid token fold journal")
      await this.storage.set(FOLD_JOURNAL_KEY, checked as unknown as Schema.Json)
      await this.applyJournal(checked)
    }
  }

  // Age only. Every step inside the window is kept, so a range filter is exact.
  private async pruneLocked(): Promise<void> {
    await this.recoverLocked()
    const now = this.now()
    if (this.lastPrunedAt !== undefined && now - this.lastPrunedAt < DAY_MS) return
    const cutoff = now - this.retentionMs
    const rows = (await scanAll(this.storage)).map((entry) => ({
      key: entry.key,
      record: asRecord(entry.value),
    }))
    const folder: TokenTelemetryRecord[] = []
    const invalid: string[] = []
    for (const { key, record } of rows) {
      if (record && key === keyFor(record.hostEventID)) {
        if (record.completedAt < cutoff) folder.push(record)
      } else {
        const value = (await this.storage.get(key))
        if (typeof value === "object" && value !== null && "apiPrice" in value) {
          throw new Error("Malformed token record api price")
        }
        invalid.push(key)
      }
    }
    await this.foldLifetime(folder)
    for (const key of invalid) await this.storage.remove(key)
    this.onRemove?.(folder)
    this.lastPrunedAt = now
  }
}
