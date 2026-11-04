import { setImmediate as yieldToHost } from "node:timers/promises"
import type { ModelRef, TokenBudgetConfig, TokenRateConfig } from "../config.ts"
import { evaluateTokenBudgets, type TokenBudgetReading } from "./budgets.ts"
import { estimateTokenCosts } from "./costs.ts"
import type { CatalogSnapshot } from "./prices.ts"
import type { ProviderErrorLedger, ProviderErrorRecord } from "./errors.ts"
import type { TokenLedger, TokenLifetime, TokenRollup, TokenRollupSlice } from "./ledger.ts"
import type { PluginAttributionClaim, PluginAttributionLedger } from "./attribution.ts"
import type { CompactionLedger, CompactionRecord } from "./compaction.ts"
import type { DirectUsageLedger, DirectUsageLifetime, DirectUsageRecord, DirectUsageRollup, DirectUsageRollupSlice } from "./direct-usage.ts"
import type { WindowLedger, WindowRecord } from "./window.ts"
import type { TokenTelemetryRecord } from "./types.ts"
import { sessionKey } from "./session-key.ts"

export const REPORT_MAX_PAGE_SIZE = 100
export const REPORT_MAX_OFFSET = 10_000
// ponytail: breakdown rows are capped at 500 after sorting by observed usage.
export const REPORT_BREAKDOWN_MAX_ITEMS = 500

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
  partialRecords: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  unknownCacheRecords: number
  hostCostUSD: number | null
  hostCostMissing: number
  // cacheRead / (cacheRead + cacheWrite). Null when cache is unknown or zero.
  cacheHitRate: number | null
}

export interface PluginUsageDimension {
  pluginID: string
  pluginName: string
  attribution: "self-reported-unverified"
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
  hostCostUSD: number | null
  hostCostMissing: number
  cacheHitRate: number | null
}

export interface DirectUsageDimension {
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
  cacheHitRate: number | null
}

// The model that ran the summary. Context is that model's catalog window, not the chat session's.
export interface CompactionUsageDimension {
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
  lastObservedAt: number | null
  lastInputTokens: number | null
  contextLimit: number | null
  contextPercent: number | null
}

export interface AgentUsageDimension {
  agentID: string
  evidence: "exact-assistant-message"
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
  hostCostUSD: number | null
  hostCostMissing: number
  cacheHitRate: number | null
  sessions: number
  lastObservedAt: number | null
  models: ProjectModelUsage[]
}

export interface PlanUsageDimension {
  plan: string
  evidence: "exact-model-reference"
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
  hostCostUSD: number | null
  hostCostMissing: number
  cacheHitRate: number | null
}

// Character length of one session's current context. Not a token count.
export interface WindowUsageSnapshot {
  source: "context-characters"
  includedInTotals: false
  observedAt: number
  user: number
  assistant: number
  tool: number
  other: number
}

// One root session, with any child sessions rolled in. The id is a short hash so
// the report never carries a raw session identifier.
export interface ProjectModelUsage {
  providerID: string
  modelID: string
  records: number
  observedTokens: number
}

export interface ProjectUsageDimension {
  projectID: string | null
  projectName: string | null
  records: number
  observedTokens: number
  unknownTokenRecords: number
  sessions: number
  lastObservedAt: number | null
  // Top models by observed tokens, so a project row can name what did the work.
  models: ProjectModelUsage[]
  modelCount: number
}

export interface SessionUsageDimension {
  sessionKey: string
  sessions: number
  messages: number
  records: number
  observedTokens: number
  unknownTokenRecords: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  lastObservedAt: number | null
  lastInputTokens: number | null
  contextLimit: number | null
  contextPercent: number | null
  providerID: string | null
  modelID: string | null
  // Host USD rolled in with this root, including child steps. Not a catalog estimate.
  hostCostUSD: number | null
  hostCostMissing: number
  // cacheRead / (cacheRead + cacheWrite). Null when this root has no cache
  // tokens or any step left a cache count unknown. Not added to observedTokens.
  cacheHitRate: number | null
  // Cache-write tokens on the first write after a host compaction in that same
  // session, and every other cache write. Tied to compaction only because that
  // session's compaction event came first. No other cause is named.
  cacheWriteAfterCompaction: number
  cacheWriteOther: number
  cacheQualityComplete: boolean
  // Share of this root's observed tokens, and of its host USD, from child
  // sessions. Null when the denominator is unknown or zero. A missing host
  // cost is not treated as zero.
  childTokenShare: number | null
  childHostCostShare: number | null
  // Latest character length of this root session's own context. Not a token count.
  window: WindowUsageSnapshot | null
}

export interface UsageBreakdownItem {
  agentID: string | null
  pluginID: string | null
  pluginName: string | null
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
  hostCostUSD: number | null
  hostCostMissing: number
  cacheHitRate: number | null
}

export interface QuartermasterReport {
  apiVersion: 1
  status: "ok"
  projectID: string
  generatedAt: number
  freshness: { source: "live-event-ledger"; latestObservedAt: number | null; complete: false }
  totals: {
    records: number
    observedTokens: number
    unknownTokenRecords: number
    // Breakdown of the same records. reasoning is part of output and cache is
    // part of input, so these are reported alongside observedTokens, never added.
    partialTokenRecords: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning: number
    unknownCacheRecords: number
    // False when a raw step or a pruned slice left cache unknown, or a daily
    // count from before category slices has no cache split.
    cacheQualityComplete: boolean
    cacheHitRate: number | null
    complete: false
  }
  range: { since: number | null; until: number | null; budgets: "all-history" }
  sessions: {
    attribution: "host-session"
    complete: false
    total: number
    offset: number
    limit: number
    nextOffset: number | null
    items: SessionUsageDimension[]
  }
  projects: {
    complete: false
    total: number
    items: ProjectUsageDimension[]
  }
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
  // The summarizer's own call, beside the model that ran it. Not part of host totals.
  compaction: {
    source: "session-compaction"
    includedInTotals: false
    complete: false
    records: number
    observedTokens: number
    unknownTokenRecords: number
    partialRecords: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning: number
    dimensions: { total: number; offset: number; limit: number; nextOffset: number | null; items: CompactionUsageDimension[] }
  }
  // Calls a plugin reported itself. Totals and plugin/model groups include
  // pruned slices. A day written before slices stays in the total only.
  // Separate from host totals.
  directUsage: {
    attribution: "self-reported-unverified"
    verified: false
    complete: false
    records: number
    observedTokens: number
    unknownTokenRecords: number
    partialRecords: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning: number
    // Pruned rows only. Not the host archived block, and not the plugin/model groups.
    archived: {
      records: number
      observedTokens: number
      unknownTokenRecords: number
      partialRecords: number
    }
    dimensions: { total: number; offset: number; limit: number; nextOffset: number | null; items: DirectUsageDimension[] }
  }
  agentAttribution: {
    evidence: "exact-assistant-message"
    complete: false
    totalRecords: number
    unknownRecords: number
    dimensions: { total: number; offset: number; limit: number; nextOffset: number | null; items: AgentUsageDimension[] }
  }
  planAttribution: {
    status: "model-match-unique"
    evidence: "exact-model-reference"
    complete: false
    totalRecords: number
    unknownRecords: number
    ambiguousRecords: number
    dimensions: { total: number; offset: number; limit: number; nextOffset: number | null; items: PlanUsageDimension[] }
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
  breakdown: {
    attribution: "self-reported-unverified"
    complete: false
    items: UsageBreakdownItem[]
  }
  // Usage older than the retained raw window. Counts only, folded into totals.
  archived: {
    source: "daily-rollups"
    complete: false
    rollups: number
    records: number
    observedTokens: number
    unknownTokenRecords: number
    // Split fields cover slices only. Older daily counts stay in records and
    // observedTokens, and leave cacheQualityComplete false.
    partialRecords: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning: number
    unknownCacheRecords: number
    cacheQualityComplete: boolean
    cacheHitRate: number | null
    hostCostUSD: number | null
    hostCostMissing: number
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

function pluginClaimsBySession(
  projectID: string,
  claims: readonly PluginAttributionClaim[],
): Map<string, Map<string, PluginAttributionClaim>> {
  const claimsBySession = new Map<string, Map<string, PluginAttributionClaim>>()
  for (const claim of claims) {
    if (claim.projectID !== projectID) continue
    const identity = JSON.stringify([claim.pluginID, claim.pluginName])
    const owners = claimsBySession.get(claim.hostSessionID) ?? new Map<string, PluginAttributionClaim>()
    owners.set(identity, claim)
    claimsBySession.set(claim.hostSessionID, owners)
  }
  return claimsBySession
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

function resolvePluginClaimForRecord(
  projectID: string,
  record: TokenTelemetryRecord,
  claimsBySession: Map<string, Map<string, PluginAttributionClaim>>,
): PluginAttributionClaim | null {
  const owners = record.hostProjectID === projectID ? claimsBySession.get(record.hostSessionID) : undefined
  if (!owners || owners.size !== 1) return null
  return owners.values().next().value as PluginAttributionClaim
}

function breakdownSubCounts(record: TokenTelemetryRecord): Pick<
  UsageBreakdownItem,
  "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning"
> {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  if (record.usageStatus === "missing") return zero
  const counts = record.counts
  if (!counts) return zero
  const { input, output, cacheRead, cacheWrite, reasoning } = counts
  if (
    !Number.isSafeInteger(input) || input < 0 ||
    !Number.isSafeInteger(output) || output < 0 ||
    !Number.isSafeInteger(cacheRead) || cacheRead < 0 ||
    !Number.isSafeInteger(cacheWrite) || cacheWrite < 0 ||
    !Number.isSafeInteger(reasoning) || reasoning < 0
  ) {
    return zero
  }
  return { input, output, cacheRead, cacheWrite, reasoning }
}

function compareBreakdownItems(a: UsageBreakdownItem, b: UsageBreakdownItem): number {
  if (b.observedTokens !== a.observedTokens) return b.observedTokens - a.observedTokens
  const agent = (a.agentID ?? "").localeCompare(b.agentID ?? "")
  if (agent !== 0) return agent
  const plugin = (a.pluginID ?? "").localeCompare(b.pluginID ?? "")
  if (plugin !== 0) return plugin
  const provider = (a.providerID ?? "").localeCompare(b.providerID ?? "")
  if (provider !== 0) return provider
  const model = (a.modelID ?? "").localeCompare(b.modelID ?? "")
  if (model !== 0) return model
  return (a.variant ?? "").localeCompare(b.variant ?? "")
}

function summarizeUsageBreakdown(
  projectID: string,
  records: readonly TokenTelemetryRecord[],
  claims: readonly PluginAttributionClaim[],
  rollups: readonly TokenRollup[],
): QuartermasterReport["breakdown"] {
  const claimsBySession = pluginClaimsBySession(projectID, claims)
  const byKey = new Map<string, UsageBreakdownItem>()
  for (const record of records) {
    if (record.hostProjectID !== projectID) continue
    const claim = resolvePluginClaimForRecord(projectID, record, claimsBySession)
    const agentID = record.hostAgentID
    const pluginID = claim?.pluginID ?? null
    const pluginName = claim?.pluginName ?? null
    const { providerID, modelID, variant } = record
    const key = JSON.stringify([agentID, pluginID, pluginName, providerID, modelID, variant])
    const item = byKey.get(key) ?? {
      agentID,
      pluginID,
      pluginName,
      providerID,
      modelID,
      variant,
      ...blankTotal(),
      cacheHitRate: null,
    }
    absorbRecord(item, record)
    byKey.set(key, item)
  }
  for (const slice of hostSlices(rollups)) {
    const key = JSON.stringify([slice.agentID, null, null, slice.providerID, slice.modelID, slice.variant])
    const item = byKey.get(key) ?? {
      agentID: slice.agentID,
      pluginID: null,
      pluginName: null,
      providerID: slice.providerID,
      modelID: slice.modelID,
      variant: slice.variant,
      ...blankTotal(),
      cacheHitRate: null,
    }
    absorbSlice(item, slice)
    byKey.set(key, item)
  }
  const items = [...byKey.values()].map((item) => ({ ...item, cacheHitRate: hitRate(item) })).sort(compareBreakdownItems).slice(0, REPORT_BREAKDOWN_MAX_ITEMS)
  return {
    attribution: "self-reported-unverified",
    complete: false,
    items,
  }
}

function summarizePluginUsage(
  projectID: string,
  records: readonly TokenTelemetryRecord[],
  claims: readonly PluginAttributionClaim[],
  query: ReportQuery,
  rollups: readonly TokenRollup[],
) {
  const claimsBySession = pluginClaimsBySession(projectID, claims)

  const usageByPlugin = new Map<string, PluginUsageDimension>()
  let unknownRecords = 0
  let ambiguousRecords = 0
  for (const record of records) {
    const owners = record.hostProjectID === projectID ? claimsBySession.get(record.hostSessionID) : undefined
    const claim = resolvePluginClaimForRecord(projectID, record, claimsBySession)
    if (!claim) {
      unknownRecords += 1
      if (owners && owners.size > 1) ambiguousRecords += 1
      continue
    }
    const key = JSON.stringify([claim.pluginID, claim.pluginName])
    const item = usageByPlugin.get(key) ?? {
      pluginID: claim.pluginID,
      pluginName: claim.pluginName,
      attribution: "self-reported-unverified" as const,
      ...blankTotal(),
      cacheHitRate: null,
    }
    absorbRecord(item, record)
    usageByPlugin.set(key, item)
  }
  // A pruned step has no plugin claim. It stays unknown, not a named plugin.
  const prunedRecords = hostSlices(rollups).reduce((sum, slice) => addNumbers(sum, slice.records), 0)
  unknownRecords += prunedRecords

  const all = [...usageByPlugin.values()].map((item) => ({ ...item, cacheHitRate: hitRate(item) })).sort((a, b) =>
    a.pluginID.localeCompare(b.pluginID) || a.pluginName.localeCompare(b.pluginName),
  )
  const page = all.slice(query.offset, query.offset + query.limit)
  return {
    attribution: "self-reported-unverified" as const,
    verified: false as const,
    complete: false as const,
    totalRecords: records.length + prunedRecords,
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

function summarizeAgentUsage(records: readonly TokenTelemetryRecord[], query: ReportQuery, rollups: readonly TokenRollup[]) {
  const usageByAgent = new Map<string, AgentUsageDimension>()
  type AgentDetail = { models: Map<string, ProjectModelUsage>; sessions: Set<string>; lastObservedAt: number | null }
  const details = new Map<string, AgentDetail>()
  const detailOf = (agentID: string) => {
    const item = details.get(agentID) ?? { models: new Map<string, ProjectModelUsage>(), sessions: new Set<string>(), lastObservedAt: null }
    details.set(agentID, item)
    return item
  }
  const addModel = (detail: AgentDetail, providerID: string | null, modelID: string | null, records: number, observedTokens: number) => {
    if (!providerID || !modelID) return
    const key = `${providerID}/${modelID}`
    const model = detail.models.get(key) ?? { providerID, modelID, records: 0, observedTokens: 0 }
    model.records += records
    model.observedTokens += observedTokens
    detail.models.set(key, model)
  }
  let unknownRecords = 0
  const addAgent = (agentID: string | null, apply: (total: RunningTotal) => void) => {
    if (!agentID) {
      unknownRecords += 1
      return
    }
    const item = usageByAgent.get(agentID) ?? {
      agentID,
      evidence: "exact-assistant-message" as const,
      ...blankTotal(),
      cacheHitRate: null,
      sessions: 0,
      lastObservedAt: null,
      models: [],
    }
    apply(item)
    usageByAgent.set(agentID, item)
  }
  for (const record of records) {
    addAgent(record.hostAgentID, (total) => absorbRecord(total, record))
    if (!record.hostAgentID) continue
    // Per-agent detail, so an agent row can be expanded the way a project row is.
    const detail = detailOf(record.hostAgentID)
    detail.sessions.add(record.hostSessionID)
    addModel(detail, record.providerID, record.modelID, 1, tokenValue(record) ?? 0)
    detail.lastObservedAt = detail.lastObservedAt === null ? record.completedAt : Math.max(detail.lastObservedAt, record.completedAt)
  }
  let prunedRecords = 0
  for (const slice of hostSlices(rollups)) {
    prunedRecords = addNumbers(prunedRecords, slice.records)
    if (!slice.agentID) {
      unknownRecords += slice.records
      continue
    }
    const item = usageByAgent.get(slice.agentID) ?? {
      agentID: slice.agentID,
      evidence: "exact-assistant-message" as const,
      ...blankTotal(),
      cacheHitRate: null,
      sessions: 0,
      lastObservedAt: null,
      models: [],
    }
    absorbSlice(item, slice)
    addModel(detailOf(slice.agentID), slice.providerID, slice.modelID, slice.records, slice.observedTokens)
    usageByAgent.set(slice.agentID, item)
  }
  const all = [...usageByAgent.values()].map((item) => {
    const detail = details.get(item.agentID)
    return {
      ...item,
      cacheHitRate: hitRate(item),
      sessions: detail?.sessions.size ?? 0,
      lastObservedAt: detail?.lastObservedAt ?? null,
      models: detail ? [...detail.models.values()].sort((a, b) => b.observedTokens - a.observedTokens).slice(0, 50) : [],
    }
  }).sort((a, b) => b.observedTokens - a.observedTokens)
  const page = all.slice(query.offset, query.offset + query.limit)
  return {
    evidence: "exact-assistant-message" as const,
    complete: false as const,
    totalRecords: records.length + prunedRecords,
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

const planRefKey = (providerID: string, modelID: string, variant: string | null): string =>
  JSON.stringify([providerID, modelID, variant])

function planRefFrom(entry: unknown): { providerID: string; modelID: string; variant: string | null } | undefined {
  const split = (id: string) => {
    const cut = id.indexOf("/")
    return cut <= 0 || cut === id.length - 1 ? undefined : { providerID: id.slice(0, cut), modelID: id.slice(cut + 1) }
  }
  if (typeof entry === "string") return split(entry) && { ...split(entry)!, variant: null }
  if (!entry || typeof entry !== "object") return undefined
  const item = entry as { id?: unknown; providerID?: unknown; modelID?: unknown; variant?: unknown }
  const variant = typeof item.variant === "string" ? item.variant : null
  // Config normalizes to providerID/modelID; a raw draft may still carry an id.
  if (typeof item.providerID === "string" && typeof item.modelID === "string" && item.providerID && item.modelID) {
    return { providerID: item.providerID, modelID: item.modelID, variant }
  }
  if (typeof item.id === "string") {
    const ref = split(item.id)
    return ref ? { ...ref, variant } : undefined
  }
  return undefined
}

function planIndex(plans: Readonly<Record<string, readonly ModelRef[]>> | undefined): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const [plan, entries] of Object.entries(plans ?? {})) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const ref = planRefFrom(entry)
      if (!ref) continue
      const key = planRefKey(ref.providerID, ref.modelID, ref.variant)
      const owners = index.get(key) ?? []
      if (!owners.includes(plan)) owners.push(plan)
      index.set(key, owners)
    }
  }
  return index
}

// A step carries no plan identity, so a record is attributed only when exactly
// one configured plan references that exact provider/model/variant.
function summarizePlanUsage(
  plans: Readonly<Record<string, readonly ModelRef[]>> | undefined,
  records: readonly TokenTelemetryRecord[],
  query: ReportQuery,
  rollups: readonly TokenRollup[],
) {
  const index = planIndex(plans)
  const usageByPlan = new Map<string, PlanUsageDimension>()
  let unknownRecords = 0
  let ambiguousRecords = 0
  const assign = (providerID: string | null, modelID: string | null, variant: string | null, weight: number, apply: (total: RunningTotal) => void) => {
    const owners = providerID && modelID ? index.get(planRefKey(providerID, modelID, variant)) : undefined
    if (!owners || owners.length === 0) {
      unknownRecords += weight
      return
    }
    if (owners.length > 1) {
      ambiguousRecords += weight
      return
    }
    const plan = owners[0]!
    const item = usageByPlan.get(plan) ?? {
      plan,
      evidence: "exact-model-reference" as const,
      ...blankTotal(),
      cacheHitRate: null,
    }
    apply(item)
    usageByPlan.set(plan, item)
  }
  for (const record of records) {
    assign(record.providerID, record.modelID, record.variant ?? null, 1, (total) => absorbRecord(total, record))
  }
  let prunedRecords = 0
  for (const slice of hostSlices(rollups)) {
    prunedRecords = addNumbers(prunedRecords, slice.records)
    assign(slice.providerID, slice.modelID, slice.variant, slice.records, (total) => absorbSlice(total, slice))
  }
  const all = [...usageByPlan.values()].map((item) => ({ ...item, cacheHitRate: hitRate(item) })).sort((a, b) => a.plan.localeCompare(b.plan))
  const page = all.slice(query.offset, query.offset + query.limit)
  return {
    status: "model-match-unique" as const,
    evidence: "exact-model-reference" as const,
    complete: false as const,
    totalRecords: records.length + prunedRecords,
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

// A step records its session and immediate parent, so a child's usage rolls up
// to the highest session that is still present in the retained records.
function latestWindows(records: readonly WindowRecord[], query: ReportQuery): Map<string, WindowUsageSnapshot> {
  const latest = new Map<string, WindowUsageSnapshot>()
  for (const record of records) {
    if (!inRange(record.observedAt, query)) continue
    const current = latest.get(record.sessionID)
    if (current && current.observedAt > record.observedAt) continue
    latest.set(record.sessionID, {
      source: "context-characters",
      includedInTotals: false,
      observedAt: record.observedAt,
      user: record.user,
      assistant: record.assistant,
      tool: record.tool,
      other: record.other,
    })
  }
  return latest
}

function knownCache(record: TokenTelemetryRecord): { cacheRead: number; cacheWrite: number } | undefined {
  if (record.usageStatus !== "reported" || record.partial !== false || !record.counts) return undefined
  const { cacheRead, cacheWrite } = record.counts
  if (!Number.isSafeInteger(cacheRead) || cacheRead < 0 || !Number.isSafeInteger(cacheWrite) || cacheWrite < 0) return undefined
  return { cacheRead, cacheWrite }
}

// The first cache write after a compaction in that same session. A write with
// the same timestamp is not after it: the compaction has to come first. A
// compaction row with no session hash cannot be joined, so it names no cause.
function cacheWritesAfterCompaction(
  records: readonly TokenTelemetryRecord[],
  compactions: readonly CompactionRecord[],
  included?: ReadonlySet<string>,
): Map<string, { afterCompaction: number; other: number }> {
  const writes = new Map<string, Array<{ at: number; write: number; count: boolean }>>()
  for (const record of records) {
    const cache = knownCache(record)
    if (!cache || cache.cacheWrite === 0) continue
    const key = sessionKey(record.hostSessionID)
    const list = writes.get(key) ?? []
    // A write outside the report still consumes the post-compaction slot so a
    // later in-range write is not labeled as the rebuild.
    list.push({
      at: record.completedAt,
      write: cache.cacheWrite,
      count: included === undefined || included.has(record.hostEventID),
    })
    writes.set(key, list)
  }
  const marks = new Map<string, number[]>()
  for (const record of compactions) {
    if (!record.sessionKey) continue
    const list = marks.get(record.sessionKey) ?? []
    list.push(record.completedAt)
    marks.set(record.sessionKey, list)
  }
  const splits = new Map<string, { afterCompaction: number; other: number }>()
  for (const key of new Set([...writes.keys(), ...marks.keys()])) {
    const events: Array<{ at: number; kind: "write" | "compaction"; write: number; count: boolean }> = []
    for (const write of writes.get(key) ?? []) events.push({ at: write.at, kind: "write", write: write.write, count: write.count })
    for (const at of marks.get(key) ?? []) events.push({ at, kind: "compaction", write: 0, count: false })
    events.sort((a, b) => a.at - b.at || (a.kind === "write" ? 0 : 1) - (b.kind === "write" ? 0 : 1))
    let pending = false
    let afterCompaction = 0
    let other = 0
    for (const event of events) {
      if (event.kind === "compaction") {
        pending = true
        continue
      }
      if (pending) {
        if (event.count && Number.isSafeInteger(afterCompaction + event.write)) afterCompaction += event.write
        pending = false
      } else if (event.count && Number.isSafeInteger(other + event.write)) other += event.write
    }
    splits.set(key, { afterCompaction, other })
  }
  return splits
}

function ratio(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null
  const value = part / whole
  return Number.isFinite(value) ? value : null
}

interface RunningTotal {
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
  hostCostUSD: number | null
  hostCostMissing: number
}

function blankTotal(): RunningTotal {
  return {
    records: 0, observedTokens: 0, unknownTokenRecords: 0, partialRecords: 0,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    unknownCacheRecords: 0, hostCostUSD: null, hostCostMissing: 0,
  }
}

function addNumbers(sum: number, value: number): number {
  return Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(sum + value) ? sum + value : sum
}

function absorbRecord(total: RunningTotal, record: TokenTelemetryRecord): void {
  total.records += 1
  const value = tokenValue(record)
  if (value === undefined || !Number.isSafeInteger(total.observedTokens + value)) total.unknownTokenRecords += 1
  else total.observedTokens += value
  if (record.partial) total.partialRecords += 1
  const sub = breakdownSubCounts(record)
  total.input = addNumbers(total.input, sub.input)
  total.output = addNumbers(total.output, sub.output)
  total.cacheRead = addNumbers(total.cacheRead, sub.cacheRead)
  total.cacheWrite = addNumbers(total.cacheWrite, sub.cacheWrite)
  total.reasoning = addNumbers(total.reasoning, sub.reasoning)
  if (!knownCache(record)) total.unknownCacheRecords += 1
  const hostCost = record.hostCostUSD
  if (typeof hostCost === "number" && Number.isFinite(hostCost) && hostCost >= 0 &&
    (total.hostCostUSD === null || Number.isFinite(total.hostCostUSD + hostCost))) {
    total.hostCostUSD = (total.hostCostUSD ?? 0) + hostCost
  } else total.hostCostMissing += 1
}

function absorbSlice(total: RunningTotal, slice: TokenRollupSlice): void {
  total.records = addNumbers(total.records, slice.records)
  total.observedTokens = addNumbers(total.observedTokens, slice.observedTokens)
  total.unknownTokenRecords = addNumbers(total.unknownTokenRecords, slice.unknownTokenRecords)
  total.partialRecords = addNumbers(total.partialRecords, slice.partialRecords)
  total.input = addNumbers(total.input, slice.input)
  total.output = addNumbers(total.output, slice.output)
  total.cacheRead = addNumbers(total.cacheRead, slice.cacheRead)
  total.cacheWrite = addNumbers(total.cacheWrite, slice.cacheWrite)
  total.reasoning = addNumbers(total.reasoning, slice.reasoning)
  total.unknownCacheRecords = addNumbers(total.unknownCacheRecords, slice.unknownCacheRecords)
  const reported = slice.records - slice.hostCostMissing
  if (reported > 0 && Number.isFinite(slice.hostCostUSD)) {
    const next = (total.hostCostUSD ?? 0) + slice.hostCostUSD
    if (Number.isFinite(next)) total.hostCostUSD = next
  }
  total.hostCostMissing = addNumbers(total.hostCostMissing, slice.hostCostMissing)
}

function hitRate(total: Pick<RunningTotal, "cacheRead" | "cacheWrite" | "unknownCacheRecords">): number | null {
  if (total.unknownCacheRecords > 0) return null
  return ratio(total.cacheRead, total.cacheRead + total.cacheWrite)
}

function hostSlices(rollups: readonly TokenRollup[]): TokenRollupSlice[] {
  return rollups.flatMap((rollup) => rollup.slices ?? [])
}

function blankDimension(dimension: UsageDimension["dimension"], value: string | null): UsageDimension {
  return {
    dimension, value, records: 0, observedTokens: 0, unknownRecords: 0,
    partialRecords: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    unknownCacheRecords: 0, hostCostUSD: null, hostCostMissing: 0, cacheHitRate: null,
  }
}

function absorbDimension(item: UsageDimension, apply: (total: RunningTotal) => void): void {
  const total: RunningTotal = {
    records: item.records,
    observedTokens: item.observedTokens,
    unknownTokenRecords: item.unknownRecords,
    partialRecords: item.partialRecords,
    input: item.input,
    output: item.output,
    cacheRead: item.cacheRead,
    cacheWrite: item.cacheWrite,
    reasoning: item.reasoning,
    unknownCacheRecords: item.unknownCacheRecords,
    hostCostUSD: item.hostCostUSD,
    hostCostMissing: item.hostCostMissing,
  }
  apply(total)
  item.records = total.records
  item.observedTokens = total.observedTokens
  item.unknownRecords = total.unknownTokenRecords
  item.partialRecords = total.partialRecords
  item.input = total.input
  item.output = total.output
  item.cacheRead = total.cacheRead
  item.cacheWrite = total.cacheWrite
  item.reasoning = total.reasoning
  item.unknownCacheRecords = total.unknownCacheRecords
  item.hostCostUSD = total.hostCostUSD
  item.hostCostMissing = total.hostCostMissing
}

// A partial sum is not a rank. Any missing step leaves the root unknown, and
// unknown is not zero, so those rows sort after every fully priced root.
function sessionHostCostRank(item: SessionUsageDimension): number | null {
  if (item.hostCostMissing > 0 || item.hostCostUSD === null) return null
  return item.hostCostUSD
}

function compareSessionsByHostCost(a: SessionUsageDimension, b: SessionUsageDimension): number {
  const aCost = sessionHostCostRank(a)
  const bCost = sessionHostCostRank(b)
  if ((aCost !== null) !== (bCost !== null)) return aCost !== null ? -1 : 1
  if (aCost !== null && bCost !== null && aCost !== bCost) return bCost - aCost
  if (a.observedTokens !== b.observedTokens) return b.observedTokens - a.observedTokens
  return a.sessionKey.localeCompare(b.sessionKey)
}

function summarizeSessions(
  records: readonly TokenTelemetryRecord[],
  query: ReportQuery,
  catalog: CatalogSnapshot | undefined,
  windows: readonly WindowRecord[] = [],
  compactions: readonly CompactionRecord[] = [],
  archived: readonly TokenLifetime[] = [],
): QuartermasterReport["sessions"] {
  const windowOf = latestWindows(windows, query)
  const ranged = records.filter((record) => inRange(record.completedAt, query))
  const included = new Set(ranged.map((record) => record.hostEventID))
  // A compaction or write outside this range still decides which later write is
  // the rebuild. Only an in-range write is added to the published split.
  const writeSplits = cacheWritesAfterCompaction(records, compactions, included)
  const parentOf = new Map<string, string | null>()
  for (const record of ranged) parentOf.set(record.hostSessionID, record.parentSessionID)
  // Folded rows keep their session ids, so a retired session resolves to the
  // same root as its children.
  for (const row of archived) {
    if (row.hostSessionID === null || parentOf.has(row.hostSessionID)) continue
    parentOf.set(row.hostSessionID, row.parentSessionID)
  }
  const rootOf = (sessionID: string): string => {
    let current = sessionID
    const seen = new Set<string>([current])
    while (true) {
      const parent = parentOf.get(current)
      if (!parent || seen.has(parent) || !parentOf.has(parent)) return current
      seen.add(parent)
      current = parent
    }
  }

  const blankUsage = (key: string): SessionUsageDimension => ({
    sessionKey: key,
    sessions: 0,
    messages: 0,
    records: 0,
    observedTokens: 0,
    unknownTokenRecords: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    lastObservedAt: null,
    lastInputTokens: null,
    contextLimit: null,
    contextPercent: null,
    providerID: null,
    modelID: null,
    hostCostUSD: null,
    hostCostMissing: 0,
    cacheHitRate: null,
    cacheWriteAfterCompaction: 0,
    cacheWriteOther: 0,
    cacheQualityComplete: false,
    childTokenShare: null,
    childHostCostShare: null,
    window: null,
  })

  const sessions = new Map<string, Set<string>>()
  const messages = new Map<string, Set<string>>()
  const usage = new Map<string, SessionUsageDimension>()
  const childTokens = new Map<string, number>()
  const childTokensBroken = new Set<string>()
  const childHost = new Map<string, number>()
  const childHostBroken = new Set<string>()
  const cacheReadKnown = new Map<string, number>()
  const cacheWriteKnown = new Map<string, number>()
  const cacheBroken = new Set<string>()
  for (const record of ranged) {
    const root = rootOf(record.hostSessionID)
    const members = sessions.get(root) ?? new Set<string>()
    members.add(record.hostSessionID)
    sessions.set(root, members)
    const ids = messages.get(root) ?? new Set<string>()
    ids.add(record.hostMessageID)
    messages.set(root, ids)

    const item = usage.get(root) ?? blankUsage(sessionKey(root))
    item.records += 1
    const value = tokenValue(record)
    if (value === undefined || !Number.isSafeInteger(item.observedTokens + value)) item.unknownTokenRecords += 1
    else item.observedTokens += value
    const sub = breakdownSubCounts(record)
    if (Number.isSafeInteger(item.input + sub.input)) item.input += sub.input
    if (Number.isSafeInteger(item.output + sub.output)) item.output += sub.output
    if (Number.isSafeInteger(item.cacheRead + sub.cacheRead)) item.cacheRead += sub.cacheRead
    if (Number.isSafeInteger(item.cacheWrite + sub.cacheWrite)) item.cacheWrite += sub.cacheWrite
    if (Number.isSafeInteger(item.reasoning + sub.reasoning)) item.reasoning += sub.reasoning
    const hostCost = record.hostCostUSD
    if (typeof hostCost === "number" && Number.isFinite(hostCost) && hostCost >= 0 &&
      (item.hostCostUSD === null || Number.isFinite(item.hostCostUSD + hostCost))) {
      item.hostCostUSD = (item.hostCostUSD ?? 0) + hostCost
    } else {
      item.hostCostMissing += 1
    }
    const cache = knownCache(record)
    if (!cache) cacheBroken.add(root)
    else {
      const read = (cacheReadKnown.get(root) ?? 0) + cache.cacheRead
      const write = (cacheWriteKnown.get(root) ?? 0) + cache.cacheWrite
      if (!Number.isSafeInteger(read) || !Number.isSafeInteger(write)) cacheBroken.add(root)
      else {
        cacheReadKnown.set(root, read)
        cacheWriteKnown.set(root, write)
      }
    }
    if (record.hostSessionID !== root) {
      if (value === undefined || !Number.isSafeInteger((childTokens.get(root) ?? 0) + value)) childTokensBroken.add(root)
      else childTokens.set(root, (childTokens.get(root) ?? 0) + value)
      if (
        typeof hostCost !== "number" || !Number.isFinite(hostCost) || hostCost < 0 ||
        !Number.isFinite((childHost.get(root) ?? 0) + hostCost)
      ) childHostBroken.add(root)
      else childHost.set(root, (childHost.get(root) ?? 0) + hostCost)
    }
    if (item.lastObservedAt === null || record.completedAt >= item.lastObservedAt) {
      item.lastObservedAt = record.completedAt
      item.providerID = record.providerID
      item.modelID = record.modelID
      const counts = record.counts
      item.lastInputTokens = counts && Number.isSafeInteger(counts.input + counts.cacheRead)
        ? counts.input + counts.cacheRead
        : null
    }
    usage.set(root, item)
  }

  // Folded history keeps no message ids, so one synthetic id per row keeps a
  // retired session from reading as zero messages.
  for (const row of archived) {
    if (row.hostSessionID === null) continue
    const root = rootOf(row.hostSessionID)
    const members = sessions.get(root) ?? new Set<string>()
    members.add(row.hostSessionID)
    sessions.set(root, members)
    const item = usage.get(root) ?? blankUsage(sessionKey(root))
    item.records += row.records
    item.observedTokens += row.observedTokens
    item.unknownTokenRecords += row.unknownTokenRecords
    item.input += row.input
    item.output += row.output
    item.cacheRead += row.cacheRead
    item.cacheWrite += row.cacheWrite
    item.reasoning += row.reasoning
    item.hostCostUSD = (item.hostCostUSD ?? 0) + row.hostCostUSD
    item.hostCostMissing += row.hostCostMissing
    if (row.unknownCacheRecords > 0) cacheBroken.add(root)
    else {
      cacheReadKnown.set(root, (cacheReadKnown.get(root) ?? 0) + row.cacheRead)
      cacheWriteKnown.set(root, (cacheWriteKnown.get(root) ?? 0) + row.cacheWrite)
    }
    if (row.hostSessionID !== root) {
      childTokens.set(root, (childTokens.get(root) ?? 0) + row.observedTokens)
      childHost.set(root, (childHost.get(root) ?? 0) + row.hostCostUSD)
    }
    if (item.providerID === null && row.providerID !== null) {
      item.providerID = row.providerID
      item.modelID = row.modelID
    }
    const ids = messages.get(root) ?? new Set<string>()
    ids.add(`archived:${row.hostSessionID}:${row.providerID ?? ""}:${row.modelID ?? ""}:${row.variant ?? ""}`)
    messages.set(root, ids)
    usage.set(root, item)
  }

  const items = [...usage.entries()].map(([root, item]) => {
    item.sessions = sessions.get(root)?.size ?? 1
    item.messages = messages.get(root)?.size ?? 0
    item.window = windowOf.get(root) ?? null
    const limit = item.providerID && item.modelID
      ? catalog?.contextLimits.get(`${item.providerID}/${item.modelID}`)
      : undefined
    item.contextLimit = limit ?? null
    item.contextPercent = limit && item.lastInputTokens !== null && limit > 0
      ? Math.min(100, Math.round((item.lastInputTokens / limit) * 100))
      : null
    let afterCompaction = 0
    let otherWrites = 0
    for (const id of sessions.get(root) ?? []) {
      const split = writeSplits.get(sessionKey(id))
      if (!split) continue
      if (Number.isSafeInteger(afterCompaction + split.afterCompaction)) afterCompaction += split.afterCompaction
      if (Number.isSafeInteger(otherWrites + split.other)) otherWrites += split.other
    }
    item.cacheWriteAfterCompaction = afterCompaction
    item.cacheWriteOther = otherWrites
    const cacheKnown = !cacheBroken.has(root)
    item.cacheQualityComplete = cacheKnown
    const read = cacheReadKnown.get(root) ?? 0
    const write = cacheWriteKnown.get(root) ?? 0
    item.cacheHitRate = cacheKnown ? ratio(read, read + write) : null
    item.childTokenShare = item.unknownTokenRecords > 0 || childTokensBroken.has(root)
      ? null
      : ratio(childTokens.get(root) ?? 0, item.observedTokens)
    item.childHostCostShare = item.hostCostMissing > 0 || item.hostCostUSD === null || childHostBroken.has(root)
      ? null
      : ratio(childHost.get(root) ?? 0, item.hostCostUSD)
    return item
  }).sort(compareSessionsByHostCost)

  const page = items.slice(query.offset, query.offset + query.limit)
  return {
    attribution: "host-session",
    complete: false,
    total: items.length,
    offset: query.offset,
    limit: query.limit,
    nextOffset: query.offset + page.length < items.length ? query.offset + page.length : null,
    items: page,
  }
}

function summarizeCompaction(
  records: readonly CompactionRecord[],
  query: ReportQuery,
  catalog: CatalogSnapshot | undefined,
): QuartermasterReport["compaction"] {
  const add = (sum: number, value: number) => Number.isSafeInteger(sum + value) && sum + value >= 0 ? sum + value : sum
  const groups = new Map<string, CompactionUsageDimension>()
  let observedTokens = 0
  let unknownTokenRecords = 0
  let partialRecords = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let reasoning = 0
  for (const record of records) {
    const counts = record.counts
    const total = counts ? counts.input + counts.output : undefined
    const known = total !== undefined && Number.isSafeInteger(total) && total >= 0 && Number.isSafeInteger(observedTokens + total)
    if (!known) unknownTokenRecords += 1
    else observedTokens += total
    if (record.partial) partialRecords += 1
    if (counts) {
      input = add(input, counts.input)
      output = add(output, counts.output)
      cacheRead = add(cacheRead, counts.cacheRead)
      cacheWrite = add(cacheWrite, counts.cacheWrite)
      reasoning = add(reasoning, counts.reasoning)
    }
    const key = JSON.stringify([record.providerID, record.modelID, record.variant])
    const item = groups.get(key) ?? {
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
      lastObservedAt: null,
      lastInputTokens: null,
      contextLimit: null,
      contextPercent: null,
    }
    item.records += 1
    if (!known || (total !== undefined && !Number.isSafeInteger(item.observedTokens + total))) item.unknownTokenRecords += 1
    else if (total !== undefined) item.observedTokens += total
    if (record.partial) item.partialRecords += 1
    if (counts) {
      item.input = add(item.input, counts.input)
      item.output = add(item.output, counts.output)
      item.cacheRead = add(item.cacheRead, counts.cacheRead)
      item.cacheWrite = add(item.cacheWrite, counts.cacheWrite)
      item.reasoning = add(item.reasoning, counts.reasoning)
    }
    if (item.lastObservedAt === null || record.completedAt >= item.lastObservedAt) {
      item.lastObservedAt = record.completedAt
      item.lastInputTokens = counts && Number.isSafeInteger(counts.input + counts.cacheRead)
        ? counts.input + counts.cacheRead
        : null
    }
    groups.set(key, item)
  }
  const items = [...groups.values()].map((item) => {
    const limit = item.providerID && item.modelID
      ? catalog?.contextLimits.get(`${item.providerID}/${item.modelID}`)
      : undefined
    item.contextLimit = limit ?? null
    item.contextPercent = limit && item.lastInputTokens !== null && limit > 0
      ? Math.min(100, Math.round((item.lastInputTokens / limit) * 100))
      : null
    return item
  }).sort((a, b) =>
    b.observedTokens - a.observedTokens ||
    (a.providerID ?? "").localeCompare(b.providerID ?? "") ||
    (a.modelID ?? "").localeCompare(b.modelID ?? ""))
  const page = items.slice(query.offset, query.offset + query.limit)
  return {
    source: "session-compaction",
    includedInTotals: false,
    complete: false,
    records: records.length,
    observedTokens,
    unknownTokenRecords,
    partialRecords,
    input, output, cacheRead, cacheWrite, reasoning,
    dimensions: {
      total: items.length,
      offset: query.offset,
      limit: query.limit,
      nextOffset: query.offset + page.length < items.length ? query.offset + page.length : null,
      items: page,
    },
  }
}

function summarizeDirectUsage(
  records: readonly DirectUsageRecord[],
  rollups: readonly DirectUsageRollup[],
  query: ReportQuery,
): QuartermasterReport["directUsage"] {
  const empty = (): DirectUsageDimension => ({
    pluginID: "", pluginName: "", providerID: "", modelID: "", variant: null,
    records: 0, observedTokens: 0, unknownTokenRecords: 0, partialRecords: 0,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    unknownCacheRecords: 0, cacheHitRate: null,
  })
  const add = (sum: number, value: number) => Number.isSafeInteger(sum + value) && sum + value >= 0 ? sum + value : sum
  const groups = new Map<string, DirectUsageDimension>()
  let observedTokens = 0
  let unknownTokenRecords = 0
  let partialRecords = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let reasoning = 0
  for (const record of records) {
    const total = record.counts.input + record.counts.output
    const known = Number.isSafeInteger(total) && total >= 0 && Number.isSafeInteger(observedTokens + total)
    if (!known) unknownTokenRecords += 1
    else observedTokens += total
    if (record.partial) partialRecords += 1
    input = add(input, record.counts.input)
    output = add(output, record.counts.output)
    cacheRead = add(cacheRead, record.counts.cacheRead)
    cacheWrite = add(cacheWrite, record.counts.cacheWrite)
    reasoning = add(reasoning, record.counts.reasoning)
    const key = JSON.stringify([record.pluginID, record.pluginName, record.providerID, record.modelID, record.variant])
    const item = groups.get(key) ?? {
      ...empty(),
      pluginID: record.pluginID,
      pluginName: record.pluginName,
      providerID: record.providerID,
      modelID: record.modelID,
      variant: record.variant,
    }
    item.records += 1
    if (!known || !Number.isSafeInteger(item.observedTokens + total)) item.unknownTokenRecords += 1
    else item.observedTokens += total
    if (record.partial) item.partialRecords += 1
    if (record.partial) item.unknownCacheRecords += 1
    item.input = add(item.input, record.counts.input)
    item.output = add(item.output, record.counts.output)
    item.cacheRead = add(item.cacheRead, record.counts.cacheRead)
    item.cacheWrite = add(item.cacheWrite, record.counts.cacheWrite)
    item.reasoning = add(item.reasoning, record.counts.reasoning)
    groups.set(key, item)
  }
  const addSlice = (slice: DirectUsageRollupSlice) => {
    const key = JSON.stringify([slice.pluginID, slice.pluginName, slice.providerID, slice.modelID, slice.variant])
    const item = groups.get(key) ?? {
      ...empty(),
      pluginID: slice.pluginID,
      pluginName: slice.pluginName,
      providerID: slice.providerID,
      modelID: slice.modelID,
      variant: slice.variant,
    }
    item.records = add(item.records, slice.records)
    item.observedTokens = add(item.observedTokens, slice.observedTokens)
    item.unknownTokenRecords = add(item.unknownTokenRecords, slice.unknownTokenRecords)
    item.partialRecords = add(item.partialRecords, slice.partialRecords)
    item.unknownCacheRecords = add(item.unknownCacheRecords, slice.unknownCacheRecords)
    item.input = add(item.input, slice.input)
    item.output = add(item.output, slice.output)
    item.cacheRead = add(item.cacheRead, slice.cacheRead)
    item.cacheWrite = add(item.cacheWrite, slice.cacheWrite)
    item.reasoning = add(item.reasoning, slice.reasoning)
    groups.set(key, item)
  }
  // A since/until filter does not apply: host totals include every rollup too.
  // Slices carry the plugin and model. A day written before slices has none.
  let archivedRecords = 0
  let archivedTokens = 0
  let archivedUnknown = 0
  let archivedPartial = 0
  for (const rollup of rollups) {
    archivedRecords = add(archivedRecords, rollup.records)
    archivedTokens = add(archivedTokens, rollup.observedTokens)
    archivedUnknown = add(archivedUnknown, rollup.unknownTokenRecords)
    archivedPartial = add(archivedPartial, rollup.partialRecords)
    input = add(input, rollup.input)
    output = add(output, rollup.output)
    cacheRead = add(cacheRead, rollup.cacheRead)
    cacheWrite = add(cacheWrite, rollup.cacheWrite)
    reasoning = add(reasoning, rollup.reasoning)
    for (const slice of rollup.slices ?? []) addSlice(slice)
  }
  const items = [...groups.values()].map((item) => ({
    ...item,
    cacheHitRate: item.unknownCacheRecords > 0 ? null : ratio(item.cacheRead, item.cacheRead + item.cacheWrite),
  })).sort((a, b) =>
    b.observedTokens - a.observedTokens || a.pluginID.localeCompare(b.pluginID) || a.modelID.localeCompare(b.modelID))
  const page = items.slice(query.offset, query.offset + query.limit)
  return {
    attribution: "self-reported-unverified",
    verified: false,
    complete: false,
    records: add(records.length, archivedRecords),
    observedTokens: add(observedTokens, archivedTokens),
    unknownTokenRecords: add(unknownTokenRecords, archivedUnknown),
    partialRecords: add(partialRecords, archivedPartial),
    input, output, cacheRead, cacheWrite, reasoning,
    archived: {
      records: archivedRecords,
      observedTokens: archivedTokens,
      unknownTokenRecords: archivedUnknown,
      partialRecords: archivedPartial,
    },
    dimensions: {
      total: items.length,
      offset: query.offset,
      limit: query.limit,
      nextOffset: query.offset + page.length < items.length ? query.offset + page.length : null,
      items: page,
    },
  }
}

// The host lists projects with their directories, which is how chat sandboxes and
// retired directories are recognised; the plugin itself cannot see that list, so
// the caller supplies the view it built from /api/project.
export interface ProjectView {
  names: ReadonlyMap<string, string>
  /** Project ids folded into another row, e.g. every chat directory into one bucket. */
  merge: ReadonlyMap<string, string>
  exclude: ReadonlySet<string>
  /** Every id the caller accounted for: named, merged or excluded. */
  known: ReadonlySet<string>
  /** Row for ids the host no longer lists; null leaves them as separate rows. */
  fallback: { id: string; name: string } | null
}

export async function buildQuartermasterReport(
  deps: {
    projectID: string
    tokenLedger: Pick<TokenLedger, "list" | "listRollups"> & { listLifetime?: TokenLedger["listLifetime"] }
    errorLedger: Pick<ProviderErrorLedger, "list">
    attributionLedger: Pick<PluginAttributionLedger, "list">
    directUsageLedger?: Pick<DirectUsageLedger, "list"> & {
      listRollups?: DirectUsageLedger["listRollups"]
      listLifetime?: DirectUsageLedger["listLifetime"]
    }
    compactionLedger?: Pick<CompactionLedger, "list">
    windowLedger?: Pick<WindowLedger, "list">
    budgets: readonly TokenBudgetConfig[] | undefined
    tokenRates: readonly TokenRateConfig[] | undefined
    plans?: Readonly<Record<string, readonly ModelRef[]>>
    catalog?: () => Promise<CatalogSnapshot>
    now?: () => number
  },
  query: ReportQuery,
  refreshed: boolean,
  view?: ProjectView,
): Promise<QuartermasterReport> {
  const now = (deps.now ?? Date.now)()
  const excluded = (projectID: string | null) => projectID !== null && (view?.exclude.has(projectID) ?? false)
  const bucketOf = (projectID: string | null) => {
    if (projectID === null) return null
    const merged = view?.merge.get(projectID)
    if (merged !== undefined) return merged
    // A directory the host no longer registers keeps its history under an id that
    // nothing can name; group those instead of printing thousands of hash rows.
    return view?.fallback && !view.known.has(projectID) ? view.fallback.id : projectID
  }
  const nameOf = (projectID: string | null) => projectID === null
    ? null
    : view?.names.get(projectID) ?? (projectID === view?.fallback?.id ? view.fallback.name : null)
  // History is older than the raw window, so a since/until view leaves it out.
  // Only an unfiltered view is all-time.
  const allTime = query.since === undefined && query.until === undefined
  const [allTokens, allErrors, allClaims, catalog, legacyRollups, legacyLifetime, directUsageRows, allCompaction, allWindows] = await Promise.all([
    // Every project: the page reads one ledger across all checkouts, so a fresh
    // host project id cannot hide the history recorded under an older one.
    deps.tokenLedger.list({}),
    deps.errorLedger.list({ projectID: deps.projectID, limit: 10_000 }),
    deps.attributionLedger.list(deps.projectID),
    deps.catalog ? deps.catalog() : Promise.resolve(undefined),
    deps.tokenLedger.listRollups ? deps.tokenLedger.listRollups({}) : Promise.resolve([]),
    deps.tokenLedger.listLifetime ? deps.tokenLedger.listLifetime({}) : Promise.resolve([]),
    // list prunes before it returns. History is read after that so a call
    // folded during this build is still in the direct-usage total.
    deps.directUsageLedger
      ? deps.directUsageLedger.list().then(async (records) => ({
          records,
          rollups: await (deps.directUsageLedger?.listRollups?.() ?? []),
          lifetime: await (deps.directUsageLedger?.listLifetime?.() ?? []),
        }))
      : Promise.resolve({
          records: [] as DirectUsageRecord[],
          rollups: [] as DirectUsageRollup[],
          lifetime: [] as DirectUsageLifetime[],
        }),
    deps.compactionLedger ? deps.compactionLedger.list() : Promise.resolve([]),
    deps.windowLedger ? deps.windowLedger.list(deps.projectID) : Promise.resolve([]),
  ])
  const prices = catalog?.prices
  // A lifetime row is one combination. Presenting it as a day rollup with a
  // single slice lets every existing fold treat both history shapes alike.
  const rollups: TokenRollup[] = (allTime ? [
    ...legacyRollups,
    ...legacyLifetime.map((row: TokenLifetime) => ({
      projectID: row.projectID,
      day: 0,
      records: row.records,
      observedTokens: row.observedTokens,
      unknownTokenRecords: row.unknownTokenRecords,
      slices: [row],
    })),
  ] : []).filter((rollup) => !excluded(rollup.projectID))
  const directRollups: DirectUsageRollup[] = allTime ? [
    ...directUsageRows.rollups,
    ...directUsageRows.lifetime.map((row: DirectUsageLifetime) => ({
      projectID: row.projectID,
      day: 0,
      records: row.records,
      observedTokens: row.observedTokens,
      unknownTokenRecords: row.unknownTokenRecords,
      partialRecords: row.partialRecords,
      input: row.input,
      output: row.output,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
      reasoning: row.reasoning,
      slices: [row],
    })),
  ] : []
  const archivedRecords = rollups.reduce((sum, rollup) => sum + rollup.records, 0)
  const archivedTokens = rollups.reduce((sum, rollup) => sum + rollup.observedTokens, 0)
  const archivedUnknown = rollups.reduce((sum, rollup) => sum + rollup.unknownTokenRecords, 0)
  const tokens = allTokens.filter((record) => inRange(record.completedAt, query) && !excluded(record.hostProjectID))
  const errors = allErrors.filter((record) => inRange(record.observedAt, query))
  const direct = directUsageRows.records.filter((record) => inRange(record.reportedAt, query))
  const compaction = allCompaction.filter((record) => inRange(record.completedAt, query) && !excluded(record.projectID))
  const dimensions = new Map<string, UsageDimension>()
  let observedTokens = 0
  let unknownTokenRecords = 0
  let partialTokenRecords = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  let unknownCacheRecords = 0
  const place = (dimension: UsageDimension["dimension"], value: string | null): UsageDimension => {
    const key = JSON.stringify([dimension, value])
    const item = dimensions.get(key) ?? blankDimension(dimension, value)
    dimensions.set(key, item)
    return item
  }
  let processed = 0
  // Project ids change when the host re-registers a directory, so usage is
  // grouped per project instead of behind the id that happens to be active.
  const projectGroups = new Map<string, {
    projectID: string | null
    projectName: string | null
    records: number
    observedTokens: number
    unknownTokenRecords: number
    sessions: Set<string>
    lastObservedAt: number | null
    models: Map<string, ProjectModelUsage>
  }>()
  const projectOf = (projectID: string | null) => {
    const id = bucketOf(projectID)
    const key = id ?? ""
    const item = projectGroups.get(key) ?? {
      projectID: id, projectName: nameOf(id), records: 0, observedTokens: 0, unknownTokenRecords: 0, sessions: new Set<string>(), lastObservedAt: null, models: new Map<string, ProjectModelUsage>(),
    }
    projectGroups.set(key, item)
    return item
  }
  const projectModel = (item: ReturnType<typeof projectOf>, providerID: string | null, modelID: string | null, records: number, observedTokens: number) => {
    if (!providerID || !modelID) return
    const key = `${providerID}/${modelID}`
    const model = item.models.get(key) ?? { providerID, modelID, records: 0, observedTokens: 0 }
    model.records += records
    model.observedTokens += observedTokens
    item.models.set(key, model)
  }
  // ponytail: retained rows still occupy O(n) memory for session joins/sorting;
  // use streaming accumulators if the 90-day working set becomes too large.
  for (const record of tokens) {
    if (++processed % 1_000 === 0) await yieldToHost()
    const value = tokenValue(record)
    if (value === undefined || !Number.isSafeInteger(observedTokens + value)) unknownTokenRecords += 1
    else observedTokens += value
    if (record.partial) partialTokenRecords += 1
    const sub = breakdownSubCounts(record)
    if (Number.isSafeInteger(inputTokens + sub.input)) inputTokens += sub.input
    if (Number.isSafeInteger(outputTokens + sub.output)) outputTokens += sub.output
    if (Number.isSafeInteger(cacheReadTokens + sub.cacheRead)) cacheReadTokens += sub.cacheRead
    if (Number.isSafeInteger(cacheWriteTokens + sub.cacheWrite)) cacheWriteTokens += sub.cacheWrite
    if (Number.isSafeInteger(reasoningTokens + sub.reasoning)) reasoningTokens += sub.reasoning
    if (!knownCache(record)) unknownCacheRecords += 1
    const projectItem = projectOf(record.hostProjectID)
    projectItem.records += 1
    if (value === undefined) projectItem.unknownTokenRecords += 1
    else projectItem.observedTokens += value
    projectItem.sessions.add(record.hostSessionID)
    projectItem.lastObservedAt = Math.max(projectItem.lastObservedAt ?? record.completedAt, record.completedAt)
    projectModel(projectItem, record.providerID, record.modelID, 1, value ?? 0)
    const targets: Array<[UsageDimension["dimension"], string | null]> = [
      ["provider", record.providerID],
      ["model", record.providerID && record.modelID ? `${record.providerID}/${record.modelID}` : null],
    ]
    for (const [dimension, target] of targets) absorbDimension(place(dimension, target), (total) => absorbRecord(total, record))
  }
  const archivedSlices = hostSlices(rollups)
  const archivedSplit = blankTotal()
  for (const slice of archivedSlices) {
    absorbSlice(archivedSplit, slice)
    const targets: Array<[UsageDimension["dimension"], string | null]> = [
      ["provider", slice.providerID],
      ["model", slice.providerID && slice.modelID ? `${slice.providerID}/${slice.modelID}` : null],
    ]
    for (const [dimension, target] of targets) absorbDimension(place(dimension, target), (total) => absorbSlice(total, slice))
  }
  inputTokens = addNumbers(inputTokens, archivedSplit.input)
  outputTokens = addNumbers(outputTokens, archivedSplit.output)
  cacheReadTokens = addNumbers(cacheReadTokens, archivedSplit.cacheRead)
  cacheWriteTokens = addNumbers(cacheWriteTokens, archivedSplit.cacheWrite)
  reasoningTokens = addNumbers(reasoningTokens, archivedSplit.reasoning)
  partialTokenRecords = addNumbers(partialTokenRecords, archivedSplit.partialRecords)
  unknownCacheRecords = addNumbers(unknownCacheRecords, archivedSplit.unknownCacheRecords)
  const legacyUnsplit = Math.max(0, archivedRecords - archivedSplit.records)
  const cacheQualityComplete = unknownCacheRecords === 0 && legacyUnsplit === 0
  for (const item of dimensions.values()) item.cacheHitRate = hitRate(item)
  const items = [...dimensions.values()].sort((a, b) =>
    a.dimension.localeCompare(b.dimension) || (a.value ?? "").localeCompare(b.value ?? ""),
  )
  const page = items.slice(query.offset, query.offset + query.limit)
  const latestObservedAt = tokens.reduce<number | null>(
    (latest, record) => Math.max(latest ?? record.completedAt, record.completedAt),
    null,
  )
  for (const rollup of rollups) {
    const item = projectOf(rollup.projectID)
    item.records += rollup.records
    item.observedTokens += rollup.observedTokens
    item.unknownTokenRecords += rollup.unknownTokenRecords
    for (const slice of rollup.slices) projectModel(item, slice.providerID, slice.modelID, slice.records, slice.observedTokens)
  }
  const projects = [...projectGroups.values()]
    .map(({ sessions: seen, models, ...item }) => ({
      ...item,
      sessions: seen.size,
      models: [...models.values()].sort((a, b) => b.observedTokens - a.observedTokens).slice(0, 50),
      modelCount: models.size,
    }))
    .sort((a, b) => b.observedTokens - a.observedTokens)
  return {
    apiVersion: 1,
    status: "ok",
    projectID: deps.projectID,
    generatedAt: now,
    freshness: { source: "live-event-ledger", latestObservedAt, complete: false },
    totals: {
      records: tokens.length + archivedRecords,
      observedTokens: observedTokens + archivedTokens,
      unknownTokenRecords: unknownTokenRecords + archivedUnknown,
      partialTokenRecords,
      input: inputTokens,
      output: outputTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
      reasoning: reasoningTokens,
      unknownCacheRecords,
      cacheQualityComplete,
      cacheHitRate: cacheQualityComplete ? ratio(cacheReadTokens, cacheReadTokens + cacheWriteTokens) : null,
      complete: false,
    },
    range: { since: query.since ?? null, until: query.until ?? null, budgets: "all-history" },
    // Full history, not the page range: an earlier compaction or write still
    // decides which later write is the cache rebuild. The summary counts only
    // steps inside the range.
    sessions: summarizeSessions(allTokens, query, catalog, allWindows, allCompaction, allTime ? legacyLifetime : []),
    projects: { complete: false, total: projects.length, items: projects },
    dimensions: {
      total: items.length,
      offset: query.offset,
      limit: query.limit,
      nextOffset: query.offset + page.length < items.length ? query.offset + page.length : null,
      items: page,
    },
    pluginAttribution: summarizePluginUsage(deps.projectID, tokens, allClaims, query, rollups),
    compaction: summarizeCompaction(compaction, query, catalog),
    directUsage: summarizeDirectUsage(direct, directRollups, query),
    agentAttribution: summarizeAgentUsage(tokens, query, rollups),
    planAttribution: summarizePlanUsage(deps.plans, tokens, query, rollups),
    budgets: evaluateTokenBudgets(deps.budgets, allTokens, now, deps.projectID, { rates: deps.tokenRates, prices }),
    costs: estimateTokenCosts(tokens, deps.tokenRates, prices),
    errors: summarizeErrors(errors),
    breakdown: summarizeUsageBreakdown(deps.projectID, tokens, allClaims, rollups),
    archived: {
      source: "daily-rollups",
      complete: false,
      rollups: rollups.length,
      records: archivedRecords,
      observedTokens: archivedTokens,
      unknownTokenRecords: archivedUnknown,
      partialRecords: archivedSplit.partialRecords,
      input: archivedSplit.input,
      output: archivedSplit.output,
      cacheRead: archivedSplit.cacheRead,
      cacheWrite: archivedSplit.cacheWrite,
      reasoning: archivedSplit.reasoning,
      unknownCacheRecords: archivedSplit.unknownCacheRecords,
      cacheQualityComplete: archivedSplit.unknownCacheRecords === 0 && legacyUnsplit === 0,
      cacheHitRate: archivedSplit.unknownCacheRecords === 0 && legacyUnsplit === 0
        ? ratio(archivedSplit.cacheRead, archivedSplit.cacheRead + archivedSplit.cacheWrite)
        : null,
      hostCostUSD: archivedSplit.hostCostUSD,
      hostCostMissing: archivedSplit.hostCostMissing,
    },
    refresh: refreshed ? "reread" : "not-requested",
  }
}
