import type { Schema } from "effect"
import type { StorageDomain } from "@opencode/plugin/promise/storage"

const PREFIX = "quartermaster:window:v1:"
const DAY_MS = 86_400_000
const RETENTION_MS = 90 * DAY_MS
const MAX_RECORDS_PER_PROJECT = 10_000
const PAGE_SIZE = 1_000

export interface WindowCounts {
  user: number
  assistant: number
  tool: number
  other: number
}

export interface WindowRecord extends WindowCounts {
  projectID: string | null
  sessionID: string
  observedAt: number
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : undefined

const whole = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const add = (sum: number, extra: number) => Number.isSafeInteger(sum + extra) ? sum + extra : sum

const chars = (value: unknown) => typeof value === "string" ? value.length : 0

function toolStateChars(state: unknown): number {
  if (!isObject(state)) return 0
  const input = typeof state.input === "string" ? state.input.length : 0
  if (!Array.isArray(state.content)) return input
  return state.content.reduce((total, item) => (
    isObject(item) && item.type === "text" ? add(total, chars(item.text)) : total
  ), input)
}

function addAssistant(buckets: WindowCounts, message: Record<string, unknown>) {
  if (!Array.isArray(message.content)) return
  for (const part of message.content) {
    if (!isObject(part)) continue
    if (part.type === "text") buckets.assistant = add(buckets.assistant, chars(part.text))
    else if (part.type === "tool") buckets.tool = add(buckets.tool, toolStateChars(part.state))
    else if (part.type === "reasoning") buckets.other = add(buckets.other, chars(part.text))
  }
}

// Character length of the current context. Text is counted and discarded.
// File bytes, metadata, and errors are not counted. This is not a token total.
export function projectWindow(messages: readonly unknown[]): WindowCounts {
  const buckets: WindowCounts = { user: 0, assistant: 0, tool: 0, other: 0 }
  for (const message of messages) {
    if (!isObject(message)) continue
    if (message.type === "assistant") {
      addAssistant(buckets, message)
      continue
    }
    if (message.type === "user") {
      buckets.user = add(buckets.user, chars(message.text))
      continue
    }
    if (message.type === "shell") {
      buckets.tool = add(buckets.tool, add(chars(message.command), chars(message.output)))
      continue
    }
    if (message.type === "compaction") {
      buckets.other = add(buckets.other, add(chars(message.summary), chars(message.recent)))
      continue
    }
    if (message.type === "synthetic" || message.type === "system" || message.type === "skill") {
      buckets.other = add(buckets.other, chars(message.text))
    }
  }
  return buckets
}

export function windowHasText(counts: WindowCounts) {
  return counts.user + counts.assistant + counts.tool + counts.other > 0
}

const keyFor = (sessionID: string) => `${PREFIX}${encodeURIComponent(sessionID)}`

function asRecord(value: unknown): WindowRecord | undefined {
  if (!isObject(value)) return undefined
  const item = value as Partial<WindowRecord>
  const projectID = item.projectID
  const sessionID = text(item.sessionID)
  if (!(projectID === null || text(projectID)) || !sessionID) return undefined
  const observedAt = item.observedAt
  const user = item.user
  const assistant = item.assistant
  const tool = item.tool
  const other = item.other
  if (!whole(observedAt)) return undefined
  if (!whole(user)) return undefined
  if (!whole(assistant)) return undefined
  if (!whole(tool)) return undefined
  if (!whole(other)) return undefined
  return { projectID: projectID ?? null, sessionID, observedAt, user, assistant, tool, other }
}

async function scanAll(storage: StorageDomain) {
  const entries: Awaited<ReturnType<StorageDomain["scan"]>>["entries"][number][] = []
  let after: string | undefined
  while (true) {
    const page = await storage.scan({ prefix: PREFIX, after, limit: PAGE_SIZE })
    entries.push(...page.entries)
    if (!page.next || page.next === after) return entries
    after = page.next
  }
}

export class WindowLedger {
  private pending = Promise.resolve()
  private readonly storage: StorageDomain
  private readonly now: () => number

  constructor(storage: StorageDomain, now: () => number = Date.now) {
    this.storage = storage
    this.now = now
  }

  ingest(record: WindowRecord): Promise<void> {
    const stored = asRecord(record)
    if (!stored) return Promise.reject(new TypeError("Invalid window record"))
    const write = this.pending.catch(() => {}).then(async () => {
      await this.storage.set(keyFor(stored.sessionID), stored as unknown as Schema.Json)
      await this.prune(stored.projectID)
    })
    this.pending = write
    return write
  }

  async list(projectID: string): Promise<WindowRecord[]> {
    await this.serialize(() => this.prune(projectID))
    const cutoff = this.now() - RETENTION_MS
    return (await scanAll(this.storage))
      .map((entry) => asRecord(entry.value))
      .filter((record): record is WindowRecord => record !== undefined && record.projectID === projectID && record.observedAt >= cutoff)
  }

  private serialize(work: () => Promise<void>) {
    const run = this.pending.catch(() => {}).then(work)
    this.pending = run
    return run
  }

  private async prune(projectID: string | null) {
    const cutoff = this.now() - RETENTION_MS
    const rows = (await scanAll(this.storage))
      .map((entry) => ({ key: entry.key, record: asRecord(entry.value) }))
      .filter((row) => row.record?.projectID === projectID)
    const fresh = rows
      .filter((row) => row.record && row.record.observedAt >= cutoff)
      .sort((a, b) => b.record!.observedAt - a.record!.observedAt)
    const keep = new Set(fresh.slice(0, MAX_RECORDS_PER_PROJECT).map((row) => row.key))
    for (const row of rows) {
      if (!keep.has(row.key)) await this.storage.remove(row.key)
    }
  }
}
