import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type { Schema } from "effect"
import type { TokenTelemetryRecord } from "./types.ts"

const PREFIX = "quartermaster:telemetry:v1:"
const ROLLUP_PREFIX = "quartermaster:telemetry:rollup:v1:"
const DAY_MS = 86_400_000
export const TOKEN_LEDGER_RETENTION_MS = 90 * DAY_MS
export const TOKEN_LEDGER_MAX_RECORDS_PER_PROJECT = 10_000
const PAGE_SIZE = 1_000

// Pruned records keep their daily counts so a report does not silently lose
// usage older than the raw window. Detail (model, agent, plugin) is not kept.
export interface TokenRollup {
  projectID: string | null
  day: number
  records: number
  observedTokens: number
  unknownTokenRecords: number
}

const rollupKey = (projectID: string | null, day: number) =>
  `${ROLLUP_PREFIX}${encodeURIComponent(JSON.stringify(projectID))}:${day}`

function asRollup(value: unknown): TokenRollup | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const rollup = value as Partial<TokenRollup>
  const valid = (item: unknown) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0
  if (rollup.projectID !== null && (typeof rollup.projectID !== "string" || !rollup.projectID)) return undefined
  if (!valid(rollup.day) || !valid(rollup.records) || !valid(rollup.observedTokens) || !valid(rollup.unknownTokenRecords)) {
    return undefined
  }
  return {
    projectID: rollup.projectID!,
    day: rollup.day!,
    records: rollup.records!,
    observedTokens: rollup.observedTokens!,
    unknownTokenRecords: rollup.unknownTokenRecords!,
  }
}

export interface TokenLedgerOptions {
  now?: () => number
  retentionMs?: number
  maxRecords?: number
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
  private readonly storage: StorageDomain
  private readonly now: () => number
  private readonly retentionMs: number
  private readonly maxRecords: number

  constructor(storage: StorageDomain, options: TokenLedgerOptions = {}) {
    this.storage = storage
    this.now = options.now ?? Date.now
    this.retentionMs = Math.max(1, options.retentionMs ?? TOKEN_LEDGER_RETENTION_MS)
    this.maxRecords = Math.max(1, Math.min(TOKEN_LEDGER_MAX_RECORDS_PER_PROJECT, Math.floor(options.maxRecords ?? TOKEN_LEDGER_MAX_RECORDS_PER_PROJECT)))
  }

  ingest(input: TokenTelemetryRecord): Promise<void> {
    const record = asRecord(input)
    if (!record) return Promise.reject(new TypeError("Invalid token telemetry record"))

    // Serialize read/prune work within this plugin instance; host KV upserts each event key atomically.
    const write = this.pending.catch(() => {}).then(async () => {
      await this.storage.set(keyFor(record.hostEventID), record as unknown as Schema.Json)
      await this.prune(record.hostProjectID)
    })
    this.pending = write
    return write
  }

  async list(query: TokenLedgerQuery = {}): Promise<TokenTelemetryRecord[]> {
    const limit = Math.max(1, Math.min(TOKEN_LEDGER_MAX_RECORDS_PER_PROJECT, Math.floor(query.limit ?? 1_000)))
    await this.serialize(() => this.prune(query.projectID))
    const entries = await scanAll(this.storage)
    const cutoff = this.now() - this.retentionMs
    return entries
      .map((entry) => ({ entry, record: asRecord(entry.value) }))
      .filter(({ entry, record }) => record !== undefined && entry.key === keyFor(record.hostEventID))
      .map(({ record }) => record!)
      .filter((record) => query.projectID === undefined || record.hostProjectID === (query.projectID ?? null))
      .filter((record) => record.completedAt >= cutoff)
      .sort((a, b) => a.completedAt - b.completedAt || a.hostEventID.localeCompare(b.hostEventID))
      .slice(-limit)
  }

  async listRollups(query: TokenLedgerQuery = {}): Promise<TokenRollup[]> {
    const entries = await scanAll(this.storage, ROLLUP_PREFIX)
    return entries
      .map((entry) => asRollup(entry.value))
      .filter((rollup): rollup is TokenRollup => rollup !== undefined)
      .filter((rollup) => query.projectID === undefined || rollup.projectID === (query.projectID ?? null))
      .sort((a, b) => a.day - b.day)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.catch(() => {}).then(operation)
    this.pending = task.then(() => {}, () => {})
    return task
  }

  private async archive(records: readonly TokenTelemetryRecord[]): Promise<void> {
    if (!records.length) return
    const existing = new Map((await scanAll(this.storage, ROLLUP_PREFIX))
      .map((entry) => asRollup(entry.value))
      .filter((rollup): rollup is TokenRollup => rollup !== undefined)
      .map((rollup) => [rollupKey(rollup.projectID, rollup.day), rollup] as const))
    for (const record of records) {
      const day = Math.floor(record.completedAt / DAY_MS) * DAY_MS
      const key = rollupKey(record.hostProjectID, day)
      const rollup = existing.get(key) ?? {
        projectID: record.hostProjectID, day, records: 0, observedTokens: 0, unknownTokenRecords: 0,
      }
      const total = record.counts ? record.counts.input + record.counts.output : undefined
      rollup.records += 1
      if (total === undefined || !Number.isSafeInteger(total) || total < 0 ||
        !Number.isSafeInteger(rollup.observedTokens + total)) {
        rollup.unknownTokenRecords += 1
      } else rollup.observedTokens += total
      existing.set(key, rollup)
    }
    await Promise.all([...existing.entries()].map(([key, rollup]) =>
      this.storage.set(key, rollup as unknown as Schema.Json)))
  }

  private async prune(projectID?: string | null): Promise<void> {
    const rows = (await scanAll(this.storage)).map((entry) => ({
      key: entry.key,
      record: asRecord(entry.value),
    }))
    const cutoff = this.now() - this.retentionMs
    const partitions = new Map<string, typeof rows>()
    for (const row of rows) {
      if (!row.record || row.key !== keyFor(row.record.hostEventID)) continue
      const partition = JSON.stringify(row.record.hostProjectID)
      const group = partitions.get(partition) ?? []
      group.push(row)
      partitions.set(partition, group)
    }

    const keepKeys = new Set<string>()
    for (const group of partitions.values()) {
      if (projectID !== undefined && group[0]?.record?.hostProjectID !== projectID) {
        for (const { key, record } of group) if (record!.completedAt >= cutoff) keepKeys.add(key)
        continue
      }
      group
        .filter(({ record }) => record!.completedAt >= cutoff)
        .sort((a, b) => b.record!.completedAt - a.record!.completedAt || b.record!.hostEventID.localeCompare(a.record!.hostEventID))
        .slice(0, this.maxRecords)
        .forEach(({ key }) => keepKeys.add(key))
    }
    const remove = rows.filter(({ key, record }) => !record || (record && key === keyFor(record.hostEventID) && !keepKeys.has(key)))
    await this.archive(remove.flatMap(({ key, record }) =>
      record && key === keyFor(record.hostEventID) ? [record] : []))
    await Promise.all(remove.map(({ key }) => this.storage.remove(key)))
  }
}
