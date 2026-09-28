import { Rpc } from "@opencode/plugin/rpc"
import type { Context } from "@opencode/plugin/promise/plugin"

export const USAGE_RPC = Rpc.define({
  id: "opencode-usage",
  methods: {
    status: {
      input: {
        type: "object",
        properties: { refresh: { type: "boolean" } },
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
})

export const USAGE_RPC_TIMEOUT_MS = 2_000
const USAGE_STALE_AFTER_MS = 5 * 60_000
const SOURCE_IDS = ["go", "codex", "cursor"] as const

export type UsageSourceID = (typeof SOURCE_IDS)[number]
export type UsageAvailability = "available" | "limited" | "unknown"
export type UsageWindowState = "ok" | "rate-limited" | "unknown"

export interface UsageWindow {
  name: string
  usedPercent: number | null
  state: UsageWindowState
  resetsAt: number | null
  resetDay?: number
  resetEstimated?: boolean
}

export interface UsageSource {
  authenticated: boolean
  checkedAt: number | null
  stale: boolean
  error: string | null
  windows: UsageWindow[]
  nextAvailableAt: number | null
  availability: UsageAvailability
}

export interface UsageSnapshot {
  updatedAt: number
  sources: Record<UsageSourceID, UsageSource>
}

export type UsageReadResult =
  | { status: "ok"; snapshot: UsageSnapshot }
  | {
      status: "unavailable"
      reason: "rpc-error" | "timeout" | "schema-mismatch" | "invalid-snapshot"
      path?: string
    }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function invalid(path: string): never {
  throw new Error(path)
}

function timestamp(value: unknown, path: string, nullable = false): number | null {
  if (nullable && value === null) return null
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return invalid(path)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return invalid(path)
  return parsed
}

function requiredTimestamp(value: unknown, path: string): number {
  const parsed = timestamp(value, path)
  if (parsed === null) return invalid(path)
  return parsed
}

function parseWindow(value: unknown, path: string): UsageWindow {
  if (!isRecord(value)) return invalid(path)
  if (
    typeof value.name !== "string" ||
    !(value.usedPercent === null || (typeof value.usedPercent === "number" && value.usedPercent >= 0 && value.usedPercent <= 100)) ||
    !["ok", "rate-limited", "unknown"].includes(String(value.state))
  ) return invalid(path)

  const result: UsageWindow = {
    name: value.name,
    usedPercent: value.usedPercent as number | null,
    state: value.state as UsageWindowState,
    resetsAt: timestamp(value.resetsAt, `${path}.resetsAt`, true),
  }
  if (value.resetDay !== undefined) {
    if (typeof value.resetDay !== "number" || !Number.isInteger(value.resetDay) || value.resetDay < 1 || value.resetDay > 31) {
      return invalid(`${path}.resetDay`)
    }
    result.resetDay = value.resetDay
  }
  if (value.resetEstimated !== undefined) {
    if (typeof value.resetEstimated !== "boolean") return invalid(`${path}.resetEstimated`)
    result.resetEstimated = value.resetEstimated
  }
  return result
}

function parseSource(value: unknown, path: string, now: number): UsageSource {
  if (
    !isRecord(value) ||
    typeof value.authenticated !== "boolean" ||
    typeof value.stale !== "boolean" ||
    !(value.error === null || typeof value.error === "string") ||
    !Array.isArray(value.windows) ||
    !["available", "limited", "unknown"].includes(String(value.availability))
  ) return invalid(path)

  const checkedAt = timestamp(value.checkedAt, `${path}.checkedAt`, true)
  const nextAvailableAt = timestamp(value.nextAvailableAt, `${path}.nextAvailableAt`, true)
  const windows = value.windows.map((window, index) => parseWindow(window, `${path}.windows[${index}]`))
  const fresh = value.authenticated && checkedAt !== null && now >= checkedAt && now - checkedAt <= USAGE_STALE_AFTER_MS && !value.stale && value.error === null
  const hasLimitedWindow = windows.some((window) => window.state === "rate-limited")
  const allWindowsAvailable = windows.length > 0 && windows.every((window) => window.state === "ok")
  const availability = !fresh
    ? "unknown"
    : value.availability === "limited" && hasLimitedWindow
      ? "limited"
      : value.availability === "available" && allWindowsAvailable
        ? "available"
        : "unknown"

  return {
    authenticated: value.authenticated,
    checkedAt,
    stale: !fresh,
    error: value.error,
    windows,
    nextAvailableAt,
    availability,
  }
}

export function normalizeUsageSnapshot(value: unknown, now = Date.now()): UsageReadResult {
  if (!isRecord(value)) return { status: "unavailable", reason: "invalid-snapshot" }
  if (value.schemaVersion !== 1) return { status: "unavailable", reason: "schema-mismatch" }

  try {
    const updatedAt = requiredTimestamp(value.updatedAt, "updatedAt")
    const sourceValues = value.sources
    const models = value.models
    if (!isRecord(sourceValues) || !isRecord(models) || !isRecord(models.go)) invalid("snapshot")
    const sources = Object.fromEntries(
      SOURCE_IDS.map((id) => [id, parseSource(sourceValues[id], `sources.${id}`, now)]),
    ) as Record<UsageSourceID, UsageSource>
    return { status: "ok", snapshot: { updatedAt, sources } }
  } catch (error) {
    return {
      status: "unavailable",
      reason: "invalid-snapshot",
      ...(error instanceof Error ? { path: error.message } : {}),
    }
  }
}

export async function readUsageStatus(
  ctx: Pick<Context, "rpc">,
  timeoutMs = USAGE_RPC_TIMEOUT_MS,
): Promise<UsageReadResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    const result = await Promise.race([
      ctx.rpc(USAGE_RPC).status({}, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          controller.abort()
          reject(new Error("usage request timed out"))
        }, timeoutMs)
      }),
    ])
    return normalizeUsageSnapshot(result)
  } catch {
    return { status: "unavailable", reason: timedOut ? "timeout" : "rpc-error" }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
