import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type { Schema } from "effect"

const PREFIX = "quartermaster:attribution:v1:"
const DAY_MS = 86_400_000
const RETENTION_MS = 90 * DAY_MS
const MAX_RECORDS_PER_PROJECT = 10_000
const PAGE_SIZE = 1_000

export const MAX_ATTRIBUTION_SESSIONS = 100

export interface PluginAttributionClaim {
  projectID: string
  pluginID: string
  pluginName: string
  hostSessionID: string
  claimedAt: number
}

function keyFor(claim: Pick<PluginAttributionClaim, "projectID" | "pluginID" | "pluginName" | "hostSessionID">) {
  return `${PREFIX}${encodeURIComponent(JSON.stringify([claim.projectID, claim.hostSessionID, claim.pluginID, claim.pluginName]))}`
}

function asRecord(value: unknown): PluginAttributionClaim | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const item = value as Partial<PluginAttributionClaim>
  if (
    typeof item.projectID !== "string" || !item.projectID.trim() ||
    typeof item.pluginID !== "string" || !item.pluginID.trim() || item.pluginID.length > 128 ||
    typeof item.pluginName !== "string" || !item.pluginName.trim() || item.pluginName.length > 128 ||
    typeof item.hostSessionID !== "string" || !item.hostSessionID.trim() || item.hostSessionID.length > 256 ||
    typeof item.claimedAt !== "number" || !Number.isFinite(item.claimedAt)
  ) return undefined
  return {
    projectID: item.projectID,
    pluginID: item.pluginID,
    pluginName: item.pluginName,
    hostSessionID: item.hostSessionID,
    claimedAt: item.claimedAt,
  }
}

export class PluginAttributionLedger {
  private pending = Promise.resolve()
  private readonly storage: StorageDomain
  private readonly now: () => number

  constructor(storage: StorageDomain, now: () => number = Date.now) {
    this.storage = storage
    this.now = now
  }

  async claim(projectID: string, pluginID: string, pluginName: string, hostSessionIDs: readonly string[]): Promise<void> {
    if (hostSessionIDs.length < 1 || hostSessionIDs.length > MAX_ATTRIBUTION_SESSIONS) {
      throw new TypeError(`Attribution claims must contain 1 to ${MAX_ATTRIBUTION_SESSIONS} session IDs`)
    }
    const now = this.now()
    const claims = [...new Set(hostSessionIDs)].map((hostSessionID) => asRecord({
      projectID, pluginID, pluginName, hostSessionID, claimedAt: now,
    }))
    if (!projectID || claims.some((claim) => !claim)) throw new TypeError("Invalid plugin attribution claim")
    const write = this.pending.catch(() => {}).then(async () => {
      for (const claim of claims) await this.storage.set(keyFor(claim!), claim as unknown as Schema.Json)
      await this.prune(projectID)
    })
    this.pending = write
    return write
  }

  async list(projectID: string): Promise<PluginAttributionClaim[]> {
    await this.serialize(() => this.prune(projectID))
    const entries: Awaited<ReturnType<StorageDomain["scan"]>>["entries"][number][] = []
    let after: string | undefined
    while (true) {
      const page = await this.storage.scan({ prefix: PREFIX, after, limit: PAGE_SIZE })
      entries.push(...page.entries)
      if (!page.next || page.next === after) break
      after = page.next
    }
    const cutoff = this.now() - RETENTION_MS
    return entries
      .map((entry) => ({ entry, claim: asRecord(entry.value) }))
      .filter(({ entry, claim }) => claim !== undefined && entry.key === keyFor(claim))
      .map(({ claim }) => claim!)
      .filter((claim) => claim.projectID === projectID && claim.claimedAt >= cutoff)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.catch(() => {}).then(operation)
    this.pending = task.then(() => {}, () => {})
    return task
  }

  private async prune(projectID: string): Promise<void> {
    const entries: Awaited<ReturnType<StorageDomain["scan"]>>["entries"][number][] = []
    let after: string | undefined
    while (true) {
      const page = await this.storage.scan({ prefix: PREFIX, after, limit: PAGE_SIZE })
      entries.push(...page.entries)
      if (!page.next || page.next === after) break
      after = page.next
    }
    const cutoff = this.now() - RETENTION_MS
    const valid = entries.map((entry) => ({ entry, claim: asRecord(entry.value) }))
      .filter(({ entry, claim }) => claim !== undefined && entry.key === keyFor(claim))
    const projectClaims = valid.filter(({ claim }) => claim!.projectID === projectID && claim!.claimedAt >= cutoff)
      .sort((a, b) => b.claim!.claimedAt - a.claim!.claimedAt || a.entry.key.localeCompare(b.entry.key))
    const keep = new Set(projectClaims.slice(0, MAX_RECORDS_PER_PROJECT).map(({ entry }) => entry.key))
    await Promise.all(valid
      .filter(({ claim, entry }) => claim!.projectID === projectID && !keep.has(entry.key))
      .map(({ entry }) => this.storage.remove(entry.key)))
  }
}
