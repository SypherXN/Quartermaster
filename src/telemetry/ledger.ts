import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type { Schema } from "effect"
import type { TokenTelemetryRecord } from "./types.ts"

const PREFIX = "quartermaster:telemetry:v1:"
// Read-only: daily rollups written before lifetime rows existed.
const ROLLUP_PREFIX = "quartermaster:telemetry:rollup:v1:"
const LIFETIME_PREFIX = "quartermaster:telemetry:lifetime:v1:"
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
export interface TokenLifetime extends TokenRollupSlice {
  projectID: string | null
}

const sliceIdentity = (item: Pick<TokenRollupSlice, "agentID" | "providerID" | "modelID" | "variant">) =>
  [item.agentID, item.providerID, item.modelID, item.variant]

const lifetimeKey = (
  projectID: string | null,
  item: Pick<TokenRollupSlice, "agentID" | "providerID" | "modelID" | "variant">,
) => `${LIFETIME_PREFIX}${encodeURIComponent(JSON.stringify([projectID, ...sliceIdentity(item)]))}`

// A raw step names its agent hostAgentID; a stored slice names it agentID.
const identityOf = (record: TokenTelemetryRecord) => ({
  agentID: record.hostAgentID,
  providerID: record.providerID,
  modelID: record.modelID,
  variant: record.variant,
})

const countable = (item: unknown) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0

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
  const slice = asSlice(value)
  if (!slice) return undefined
  return { projectID: projectID as string | null, ...slice }
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

export interface TokenLedgerOptions {
  now?: () => number
  retentionMs?: number
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
  }
}

export class TokenLedger {
  private pending = Promise.resolve()
  // Per instance: first activity after startup, then at most once per 24 hours.
  private lastPrunedAt: number | undefined
  private readonly storage: StorageDomain
  private readonly now: () => number
  private readonly retentionMs: number

  constructor(storage: StorageDomain, options: TokenLedgerOptions = {}) {
    this.storage = storage
    this.now = options.now ?? Date.now
    this.retentionMs = Math.max(1, options.retentionMs ?? TOKEN_LEDGER_RETENTION_MS)
  }

  ingest(input: TokenTelemetryRecord): Promise<void> {
    const record = asRecord(input)
    if (!record) return Promise.reject(new TypeError("Invalid token telemetry record"))

    // Serialize read/prune work within this plugin instance; host KV upserts each event key atomically.
    const write = this.pending.catch(() => {}).then(async () => {
      await this.storage.set(keyFor(record.hostEventID), record as unknown as Schema.Json)
      await this.prune()
    })
    this.pending = write
    return write
  }

  async list(query: TokenLedgerQuery = {}): Promise<TokenTelemetryRecord[]> {
    const limit = Math.max(1, Math.floor(query.limit ?? 10_000))
    await this.serialize(() => this.prune())
    const entries = await scanAll(this.storage)
    // Keep pending expiry visible until it is folded, so All never loses usage.
    return entries
      .map((entry) => ({ entry, record: asRecord(entry.value) }))
      .filter(({ entry, record }) => record !== undefined && entry.key === keyFor(record.hostEventID))
      .map(({ record }) => record!)
      .filter((record) => query.projectID === undefined || record.hostProjectID === (query.projectID ?? null))
      .sort((a, b) => a.completedAt - b.completedAt || a.hostEventID.localeCompare(b.hostEventID))
      .slice(-limit)
  }

  // Legacy daily rollups, written before lifetime rows existed. Never written now.
  async listRollups(query: TokenLedgerQuery = {}): Promise<TokenRollup[]> {
    const entries = await scanAll(this.storage, ROLLUP_PREFIX)
    return entries
      .map((entry) => asRollup(entry.value))
      .filter((rollup): rollup is TokenRollup => rollup !== undefined)
      .filter((rollup) => query.projectID === undefined || rollup.projectID === (query.projectID ?? null))
      .sort((a, b) => a.day - b.day)
  }

  // Serialized so a fold that a concurrent list triggered is already on disk.
  async listLifetime(query: TokenLedgerQuery = {}): Promise<TokenLifetime[]> {
    const entries = await this.serialize(() => scanAll(this.storage, LIFETIME_PREFIX))
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

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.catch(() => {}).then(operation)
    this.pending = task.then(() => {}, () => {})
    return task
  }

  // One row per agent, provider, model, and variant, all-time. A step that
  // leaves the raw window lands here; it is never written twice.
  private async foldLifetime(records: readonly TokenTelemetryRecord[]): Promise<void> {
    if (!records.length) return
    const existing = new Map((await scanAll(this.storage, LIFETIME_PREFIX))
      .map((entry) => asLifetime(entry.value))
      .filter((row): row is TokenLifetime => row !== undefined)
      .map((row) => [lifetimeKey(row.projectID, row), row] as const))
    for (const record of records) {
      const key = lifetimeKey(record.hostProjectID, identityOf(record))
      const row = existing.get(key) ?? { projectID: record.hostProjectID, ...emptySlice(record) }
      addToSlice(row, record)
      existing.set(key, row)
    }
    await Promise.all([...existing.entries()].map(([key, row]) =>
      this.storage.set(key, row as unknown as Schema.Json)))
  }

  // Age only. Every step inside the window is kept, so a range filter is exact.
  private async prune(): Promise<void> {
    const now = this.now()
    if (this.lastPrunedAt !== undefined && now - this.lastPrunedAt < DAY_MS) return
    const cutoff = now - this.retentionMs
    const rows = (await scanAll(this.storage)).map((entry) => ({
      key: entry.key,
      record: asRecord(entry.value),
    }))
    const expired = rows.filter(({ key, record }) =>
      !record || (key === keyFor(record.hostEventID) && record.completedAt < cutoff))
    await this.foldLifetime(expired.flatMap(({ key, record }) =>
      record && key === keyFor(record.hostEventID) ? [record] : []))
    await Promise.all(expired.map(({ key }) => this.storage.remove(key)))
    this.lastPrunedAt = now
  }
}
