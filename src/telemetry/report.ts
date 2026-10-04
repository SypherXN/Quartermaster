import type { TokenBudgetConfig, TokenRateConfig } from "../config.ts"
import { evaluateTokenBudgets, type TokenBudgetReading } from "./budgets.ts"
import { estimateTokenCosts } from "./costs.ts"
import type { ProviderErrorLedger, ProviderErrorRecord } from "./errors.ts"
import type { TokenLedger } from "./ledger.ts"
import type { PluginAttributionClaim, PluginAttributionLedger } from "./attribution.ts"
import type { TokenTelemetryRecord } from "./types.ts"

export const REPORT_MAX_PAGE_SIZE = 100
export const REPORT_MAX_OFFSET = 10_000

export interface ReportQuery {
  since?: number
  until?: number
  limit: number
  offset: number
}

export interface UsageDimension {
  dimension: "provider" | "model"
  value: string | null
  records: number
  observedTokens: number
  unknownRecords: number
}

export interface PluginUsageDimension {
  pluginID: string
  pluginName: string
  attribution: "self-reported-unverified"
  records: number
  observedTokens: number
  unknownTokenRecords: number
}

export interface AgentUsageDimension {
  agentID: string
  evidence: "exact-assistant-message"
  records: number
  observedTokens: number
  unknownTokenRecords: number
}

export interface QuartermasterReport {
  apiVersion: 1
  status: "ok"
  projectID: string
  generatedAt: number
  freshness: { source: "live-event-ledger"; latestObservedAt: number | null; complete: false }
  totals: { records: number; observedTokens: number; unknownTokenRecords: number; complete: false }
  dimensions: { total: number; offset: number; limit: number; nextOffset: number | null; items: UsageDimension[] }
  pluginAttribution: {
    attribution: "self-reported-unverified"
    verified: false
    complete: false
    totalRecords: number
    unknownRecords: number
    ambiguousRecords: number
    dimensions: { total: number; offset: number; limit: number; nextOffset: number | null; items: PluginUsageDimension[] }
  }
  agentAttribution: {
    evidence: "exact-assistant-message"
    complete: false
    totalRecords: number
    unknownRecords: number
    dimensions: { total: number; offset: number; limit: number; nextOffset: number | null; items: AgentUsageDimension[] }
  }
  planAttribution: {
    status: "unsupported"
    reasonCode: "no-exact-plan-step-link"
    complete: false
    unknownRecords: number
  }
  budgets: TokenBudgetReading[]
  costs: ReturnType<typeof estimateTokenCosts>
  errors: {
    attribution: "session-project"
    unattributedExcluded: true
    complete: false
    total: number
    byClassification: Record<string, { count: number; latestObservedAt: number | null }>
  }
  refresh: "reread" | "not-requested"
}

function tokenValue(record: TokenTelemetryRecord): number | undefined {
  const counts = record.counts
  if (!counts) return undefined
  const total = counts.input + counts.output
  return Number.isSafeInteger(counts.input) && counts.input >= 0 &&
    Number.isSafeInteger(counts.output) && counts.output >= 0 && Number.isSafeInteger(total)
    ? total
    : undefined
}

function inRange(timestamp: number, query: ReportQuery): boolean {
  return (query.since === undefined || timestamp >= query.since) &&
    (query.until === undefined || timestamp <= query.until)
}

function summarizeErrors(records: readonly ProviderErrorRecord[]) {
  const byClassification: Record<string, { count: number; latestObservedAt: number | null }> = {}
  for (const record of records) {
    const summary = byClassification[record.classification] ?? { count: 0, latestObservedAt: null }
    summary.count += 1
    summary.latestObservedAt = Math.max(summary.latestObservedAt ?? record.observedAt, record.observedAt)
    byClassification[record.classification] = summary
  }
  return {
    attribution: "session-project" as const,
    unattributedExcluded: true as const,
    complete: false as const,
    total: records.length,
    byClassification,
  }
}

function summarizePluginUsage(
  projectID: string,
  records: readonly TokenTelemetryRecord[],
  claims: readonly PluginAttributionClaim[],
  query: ReportQuery,
) {
  const claimsBySession = new Map<string, Map<string, PluginAttributionClaim>>()
  for (const claim of claims) {
    if (claim.projectID !== projectID) continue
    const identity = JSON.stringify([claim.pluginID, claim.pluginName])
    const owners = claimsBySession.get(claim.hostSessionID) ?? new Map<string, PluginAttributionClaim>()
    owners.set(identity, claim)
    claimsBySession.set(claim.hostSessionID, owners)
  }

  const usageByPlugin = new Map<string, PluginUsageDimension>()
  let unknownRecords = 0
  let ambiguousRecords = 0
  for (const record of records) {
    const owners = record.hostProjectID === projectID ? claimsBySession.get(record.hostSessionID) : undefined
    if (!owners || owners.size !== 1) {
      unknownRecords += 1
      if (owners && owners.size > 1) ambiguousRecords += 1
      continue
    }
    const claim = owners.values().next().value as PluginAttributionClaim
    const key = JSON.stringify([claim.pluginID, claim.pluginName])
    const item = usageByPlugin.get(key) ?? {
      pluginID: claim.pluginID,
      pluginName: claim.pluginName,
      attribution: "self-reported-unverified" as const,
      records: 0,
      observedTokens: 0,
      unknownTokenRecords: 0,
    }
    item.records += 1
    const value = tokenValue(record)
    if (value === undefined || !Number.isSafeInteger(item.observedTokens + value)) item.unknownTokenRecords += 1
    else item.observedTokens += value
    usageByPlugin.set(key, item)
  }

  const all = [...usageByPlugin.values()].sort((a, b) =>
    a.pluginID.localeCompare(b.pluginID) || a.pluginName.localeCompare(b.pluginName),
  )
  const page = all.slice(query.offset, query.offset + query.limit)
  return {
    attribution: "self-reported-unverified" as const,
    verified: false as const,
    complete: false as const,
    totalRecords: records.length,
    unknownRecords,
    ambiguousRecords,
    dimensions: {
      total: all.length,
      offset: query.offset,
      limit: query.limit,
      nextOffset: query.offset + page.length < all.length ? query.offset + page.length : null,
      items: page,
    },
  }
}

function summarizeAgentUsage(records: readonly TokenTelemetryRecord[], query: ReportQuery) {
  const usageByAgent = new Map<string, AgentUsageDimension>()
  let unknownRecords = 0
  for (const record of records) {
    if (!record.hostAgentID) {
      unknownRecords += 1
      continue
    }
    const item = usageByAgent.get(record.hostAgentID) ?? {
      agentID: record.hostAgentID,
      evidence: "exact-assistant-message" as const,
      records: 0,
      observedTokens: 0,
      unknownTokenRecords: 0,
    }
    item.records += 1
    const value = tokenValue(record)
    if (value === undefined || !Number.isSafeInteger(item.observedTokens + value)) item.unknownTokenRecords += 1
    else item.observedTokens += value
    usageByAgent.set(record.hostAgentID, item)
  }
  const all = [...usageByAgent.values()].sort((a, b) => a.agentID.localeCompare(b.agentID))
  const page = all.slice(query.offset, query.offset + query.limit)
  return {
    evidence: "exact-assistant-message" as const,
    complete: false as const,
    totalRecords: records.length,
    unknownRecords,
    dimensions: {
      total: all.length,
      offset: query.offset,
      limit: query.limit,
      nextOffset: query.offset + page.length < all.length ? query.offset + page.length : null,
      items: page,
    },
  }
}

export async function buildQuartermasterReport(
  deps: {
    projectID: string
    tokenLedger: TokenLedger
    errorLedger: ProviderErrorLedger
    attributionLedger: PluginAttributionLedger
    budgets: readonly TokenBudgetConfig[] | undefined
    tokenRates: readonly TokenRateConfig[] | undefined
    now?: () => number
  },
  query: ReportQuery,
  refreshed: boolean,
): Promise<QuartermasterReport> {
  const now = (deps.now ?? Date.now)()
  const [allTokens, allErrors, allClaims] = await Promise.all([
    deps.tokenLedger.list({ projectID: deps.projectID, limit: 10_000 }),
    deps.errorLedger.list({ projectID: deps.projectID, limit: 10_000 }),
    deps.attributionLedger.list(deps.projectID),
  ])
  const tokens = allTokens.filter((record) => inRange(record.completedAt, query))
  const errors = allErrors.filter((record) => inRange(record.observedAt, query))
  const dimensions = new Map<string, UsageDimension>()
  let observedTokens = 0
  let unknownTokenRecords = 0
  for (const record of tokens) {
    const value = tokenValue(record)
    if (value === undefined || !Number.isSafeInteger(observedTokens + value)) unknownTokenRecords += 1
    else observedTokens += value
    const targets: Array<[UsageDimension["dimension"], string | null]> = [
      ["provider", record.providerID],
      ["model", record.providerID && record.modelID ? `${record.providerID}/${record.modelID}` : null],
    ]
    for (const [dimension, target] of targets) {
      const key = JSON.stringify([dimension, target])
      const item = dimensions.get(key) ?? { dimension, value: target, records: 0, observedTokens: 0, unknownRecords: 0 }
      item.records += 1
      if (value === undefined || !Number.isSafeInteger(item.observedTokens + value)) item.unknownRecords += 1
      else item.observedTokens += value
      dimensions.set(key, item)
    }
  }
  const items = [...dimensions.values()].sort((a, b) =>
    a.dimension.localeCompare(b.dimension) || (a.value ?? "").localeCompare(b.value ?? ""),
  )
  const page = items.slice(query.offset, query.offset + query.limit)
  const latestObservedAt = tokens.reduce<number | null>(
    (latest, record) => Math.max(latest ?? record.completedAt, record.completedAt),
    null,
  )
  return {
    apiVersion: 1,
    status: "ok",
    projectID: deps.projectID,
    generatedAt: now,
    freshness: { source: "live-event-ledger", latestObservedAt, complete: false },
    totals: { records: tokens.length, observedTokens, unknownTokenRecords, complete: false },
    dimensions: {
      total: items.length,
      offset: query.offset,
      limit: query.limit,
      nextOffset: query.offset + page.length < items.length ? query.offset + page.length : null,
      items: page,
    },
    pluginAttribution: summarizePluginUsage(deps.projectID, tokens, allClaims, query),
    agentAttribution: summarizeAgentUsage(tokens, query),
    planAttribution: {
      status: "unsupported",
      reasonCode: "no-exact-plan-step-link",
      complete: false,
      unknownRecords: tokens.length,
    },
    budgets: evaluateTokenBudgets(deps.budgets, allTokens, now, deps.projectID),
    costs: estimateTokenCosts(tokens, deps.tokenRates),
    errors: summarizeErrors(errors),
    refresh: refreshed ? "reread" : "not-requested",
  }
}
