import type { TokenBudgetCalendarWindow, TokenBudgetConfig } from "../config.ts"
import type { TokenTelemetryRecord } from "./types.ts"

export interface TokenBudgetReading {
  id: string
  dimension: TokenBudgetConfig["dimension"]
  target?: string
  limitTokens: number
  windowStart: number
  windowEnd: number
  windowMs?: number
  calendarWindow?: TokenBudgetCalendarWindow
  observedTokens: number
  unknownRecords: number
  /** The live event stream has no replay or completeness watermark. */
  complete: false
  /** Deliberately absent: observed usage is only a lower bound. */
  remainingTokens: null
  /** True only when observed usage alone proves the limit was reached. */
  limitReached: boolean
}

function matches(
  budget: TokenBudgetConfig,
  record: TokenTelemetryRecord,
  projectID: string | undefined,
): boolean | undefined {
  switch (budget.dimension) {
    case "project":
      if (!projectID || !record.hostProjectID) return undefined
      return record.hostProjectID === projectID
    case "provider":
      if (!record.providerID) return undefined
      return record.providerID === budget.target
    case "model":
      if (!record.providerID) return undefined
      if (!budget.target?.startsWith(`${record.providerID}/`)) return false
      if (!record.modelID) return undefined
      return `${record.providerID}/${record.modelID}` === budget.target
    case "plugin":
      return undefined
  }
}

function calendarKey(
  timestamp: number,
  window: TokenBudgetCalendarWindow,
  formatter: Intl.DateTimeFormat,
): string {
  const parts = Object.fromEntries(
    formatter.formatToParts(timestamp).map(({ type, value }) => [type, value]),
  )
  const year = Number(parts.year)
  const month = Number(parts.month)
  const day = Number(parts.day)
  if (window.unit === "month") return `${year}-${month}`
  if (window.unit === "day") return `${year}-${month}-${day}`
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const monday = day - ((weekday + 6) % 7)
  return String(Date.UTC(year, month - 1, monday))
}

function calendarWindowStart(now: number, window: TokenBudgetCalendarWindow): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: window.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const current = calendarKey(now, window, formatter)
  let span = window.unit === "day" ? 2 : window.unit === "week" ? 9 : 40
  let before = now - span * 86_400_000
  while (calendarKey(before, window, formatter) === current) {
    span *= 2
    before = now - span * 86_400_000
    if (!Number.isFinite(before)) throw new RangeError("calendar window is out of range")
  }

  let after = now
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2)
    if (calendarKey(middle, window, formatter) === current) after = middle
    else before = middle
  }
  return after
}

/** Evaluate each budget independently over its rolling or calendar window. */
export function evaluateTokenBudgets(
  budgets: readonly TokenBudgetConfig[] | undefined,
  records: readonly TokenTelemetryRecord[],
  now: number,
  projectID?: string,
): TokenBudgetReading[] {
  if (budgets === undefined || budgets.length === 0) return []
  if (!Number.isFinite(now)) throw new TypeError("now must be finite")

  return budgets.map((budget) => {
    const windowStart = budget.calendarWindow
      ? calendarWindowStart(now, budget.calendarWindow)
      : now - budget.windowMs!
    let observedTokens = 0
    let unknownRecords = 0

    for (const record of records) {
      if (record.completedAt < windowStart || record.completedAt > now) continue
      const match = matches(budget, record, projectID)
      if (match === false) continue
      if (match === undefined || record.counts === null) {
        unknownRecords += 1
        continue
      }

      // reasoning is part of output, and cache counts are input breakdowns.
      // Adding them again would double-count the same usage.
      const { input, output } = record.counts
      const total = input + output
      if (
        !Number.isSafeInteger(input) || input < 0 ||
        !Number.isSafeInteger(output) || output < 0 ||
        !Number.isSafeInteger(total) || !Number.isSafeInteger(observedTokens + total)
      ) {
        unknownRecords += 1
        continue
      }
      observedTokens += total
    }

    return {
      id: budget.id,
      dimension: budget.dimension,
      ...(budget.target === undefined ? {} : { target: budget.target }),
      limitTokens: budget.limitTokens,
      windowStart,
      windowEnd: now,
      ...(budget.windowMs === undefined ? {} : { windowMs: budget.windowMs }),
      ...(budget.calendarWindow === undefined ? {} : { calendarWindow: budget.calendarWindow }),
      observedTokens,
      unknownRecords,
      complete: false,
      remainingTokens: null,
      limitReached: observedTokens >= budget.limitTokens,
    }
  })
}
