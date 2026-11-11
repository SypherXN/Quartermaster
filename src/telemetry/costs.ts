import type { TokenRateConfig } from "../config.ts"
import { selectPrice, type CatalogPrice, type PriceTable } from "./prices.ts"
import type { TokenTelemetryRecord } from "./types.ts"

export interface TokenCostCurrencySummary {
  currency: string
  estimatedAmount: number
  estimatedCacheReadSavings: number
  cacheSavingsRecords: number
  pricedRecords: number
  pricedTokens: number
  source: "config" | "catalog" | "config+catalog"
  rates: TokenRateConfig[]
}

export interface HostReportedCost {
  currency: "USD"
  amount: number | null
  records: number
  missingRecords: number
}

// The host's own USD figure for a finished step. Missing on older rows. This is
// not added to the catalog estimate, and a step with no figure stays missing.
function hostReportedCost(records: readonly TokenTelemetryRecord[]): HostReportedCost {
  let amount = 0
  let reported = 0
  let missingRecords = 0
  for (const record of records) {
    const cost = record.hostCostUSD
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || !Number.isFinite(amount + cost)) {
      missingRecords += 1
      continue
    }
    amount += cost
    reported += 1
  }
  return { currency: "USD", amount: reported > 0 ? amount : null, records: reported, missingRecords }
}

export interface ComponentCost {
  currency: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  pricedRecords: number
  unpricedRecords: number
}

// Costs per component for one provider/model, resolved exactly the way the total
// estimate resolves them (config rate first, then the catalog), so a detail row
// adds up to the same figure the totals report.
export function estimateComponentCosts(
  records: readonly TokenTelemetryRecord[],
  rates: readonly TokenRateConfig[] = [],
  prices?: PriceTable,
) {
  const byKey = new Map(rates.map((rate) => [
    JSON.stringify([rate.providerID, rate.modelID, rate.variant ?? null]), rate,
  ]))
  const groups = new Map<string, ComponentCost>()
  for (const record of records) {
    if (!record.providerID || !record.modelID) continue
    const key = `${record.providerID}/${record.modelID}`
    const summary = groups.get(key) ?? {
      currency: "USD", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, pricedRecords: 0, unpricedRecords: 0,
    }
    groups.set(key, summary)
    const counts = record.counts
    if (!counts || !Number.isSafeInteger(counts.input) || counts.input < 0 ||
      !Number.isSafeInteger(counts.output) || counts.output < 0) {
      summary.unpricedRecords += 1
      continue
    }
    const rate = byKey.get(JSON.stringify([record.providerID, record.modelID, record.variant ?? null]))
    const catalog = rate ? undefined : selectPrice(prices?.get(key), counts.input + counts.cacheRead)
    const terms = rate ?? catalog
    if (!terms) {
      summary.unpricedRecords += 1
      continue
    }
    const inputRate = rate ? rate.inputPerMillion : catalog!.input
    const outputRate = rate ? rate.outputPerMillion : catalog!.output
    const cacheReadRate = rate ? 0 : catalog!.cacheRead
    const cacheWriteRate = rate ? 0 : catalog!.cacheWrite
    const input = counts.input * inputRate / 1_000_000
    const output = counts.output * outputRate / 1_000_000
    const cacheRead = counts.cacheRead * cacheReadRate / 1_000_000
    const cacheWrite = counts.cacheWrite * cacheWriteRate / 1_000_000
    const total = input + output + cacheRead + cacheWrite
    if (![input, output, cacheRead, cacheWrite, summary.total + total].every((value) => Number.isFinite(value))) {
      summary.unpricedRecords += 1
      continue
    }
    summary.currency = rate?.currency ?? summary.currency
    summary.input += input
    summary.output += output
    summary.cacheRead += cacheRead
    summary.cacheWrite += cacheWrite
    summary.total += total
    summary.pricedRecords += 1
  }
  return groups
}

// Config rates are exact and win; otherwise the model catalog prices the record.
// Reasoning is billed as output by providers but the catalog never states it, so
// it stays out of the amount and is reported as a token count only.
export function estimateTokenCosts(
  records: readonly TokenTelemetryRecord[],
  rates: readonly TokenRateConfig[] = [],
  prices?: PriceTable,
) {
  const byKey = new Map(rates.map((rate) => [
    JSON.stringify([rate.providerID, rate.modelID, rate.variant ?? null]), rate,
  ]))
  const byCurrency = new Map<string, TokenCostCurrencySummary>()
  const usedRates = new Map<string, Set<string>>()
  const sources = new Map<string, Set<"config" | "catalog">>()
  let pricedRecords = 0
  let pricedTokens = 0
  let unpricedRecords = 0
  let unpricedTokens = 0
  let unknownTokenRecords = 0
  let cacheUnpricedRecords = 0
  const hostReported = hostReportedCost(records)

  const addUnpriced = (tokens?: number) => {
    unpricedRecords += 1
    if (tokens === undefined || !Number.isSafeInteger(unpricedTokens + tokens)) unknownTokenRecords += 1
    else unpricedTokens += tokens
  }

  for (const record of records) {
    const counts = record.counts
    if (!counts || !Number.isSafeInteger(counts.input) || counts.input < 0 ||
      !Number.isSafeInteger(counts.output) || counts.output < 0 ||
      !Number.isSafeInteger(counts.input + counts.output)) {
      addUnpriced()
      continue
    }
    const tokens = counts.input + counts.output
    const identity = record.providerID && record.modelID
      ? JSON.stringify([record.providerID, record.modelID, record.variant ?? null])
      : undefined
    const rate = identity ? byKey.get(identity) : undefined
    const catalog = rate || !record.providerID || !record.modelID
      ? undefined
      : selectPrice(prices?.get(`${record.providerID}/${record.modelID}`), counts.input + counts.cacheRead)
    const terms = rate ?? catalog
    if (!terms) {
      addUnpriced(tokens)
      continue
    }
    const cacheReadRate = rate ? 0 : catalog!.cacheRead
    const cacheWriteRate = rate ? 0 : catalog!.cacheWrite
    const inputRate = rate ? rate.inputPerMillion : catalog!.input
    const outputRate = rate ? rate.outputPerMillion : catalog!.output
    const amountUSD = (counts.input * inputRate + counts.output * outputRate +
      counts.cacheRead * cacheReadRate + counts.cacheWrite * cacheWriteRate) / 1_000_000
    const currency = rate?.currency ?? "USD"
    const summary = byCurrency.get(currency) ?? {
      currency,
      estimatedAmount: 0,
      estimatedCacheReadSavings: 0,
      cacheSavingsRecords: 0,
      pricedRecords: 0,
      pricedTokens: 0,
      source: rate ? ("config" as const) : ("catalog" as const),
      rates: [],
    }
    if (!Number.isFinite(amountUSD) || !Number.isFinite(summary.estimatedAmount + amountUSD) ||
      !Number.isSafeInteger(pricedTokens + tokens) ||
      !Number.isSafeInteger(summary.pricedTokens + tokens)) {
      addUnpriced(tokens)
      continue
    }
    pricedRecords += 1
    pricedTokens += tokens
    summary.estimatedAmount += amountUSD
    // A counterfactual read discount, not an invoice or a change to token totals.
    // Config rates omit cache pricing, and partial rows cannot establish savings.
    const savings = counts.cacheRead * (inputRate - cacheReadRate) / 1_000_000
    if (!rate && catalog?.cacheReadKnown !== false && !record.partial && Number.isSafeInteger(counts.cacheRead) && counts.cacheRead >= 0 &&
      Number.isFinite(savings) && Number.isFinite(summary.estimatedCacheReadSavings + savings)) {
      summary.estimatedCacheReadSavings += savings
      summary.cacheSavingsRecords += 1
    }
    summary.pricedRecords += 1
    summary.pricedTokens += tokens
    const seenSources = sources.get(currency) ?? new Set<"config" | "catalog">()
    seenSources.add(rate ? "config" : "catalog")
    sources.set(currency, seenSources)
    if (seenSources.size > 1) summary.source = "config+catalog"
    if (rate && counts.cacheRead + counts.cacheWrite > 0) cacheUnpricedRecords += 1
    byCurrency.set(currency, summary)
    if (rate) {
      const seen = usedRates.get(currency) ?? new Set<string>()
      if (!seen.has(identity!)) summary.rates.push(rate)
      seen.add(identity!)
      usedRates.set(currency, seen)
    }
  }

  return {
    status: "estimated-not-billed" as const,
    basis: "input-output-cache-per-million" as const,
    complete: false as const,
    pricedRecords,
    pricedTokens,
    unpricedRecords,
    unpricedTokens,
    // Percentage of known input+output tokens only; unknown counts stay separate.
    unpricedTokenPercentage: pricedTokens + unpricedTokens > 0
      ? 100 * (unpricedTokens / (pricedTokens + unpricedTokens)) : null,
    unknownTokenRecords,
    // Records priced from a config rate: that rate prices no cache tokens.
    cacheUnpricedRecords,
    currencies: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    // The host's own USD total. Not added to the catalog estimate or to budgets.
    hostReported,
  }
}

export interface ApiComponentCost extends ComponentCost {
  cacheUnpricedRecords: number
  partialRecords: number
}

export type ApiEquivalentCosts = ReturnType<typeof estimateTokenCosts> & {
  pricing: "recorded-api-price"
  scope: "retained-raw-records" | "selected-range-with-older-cumulative"
  partialRecords: number
  retainedUSD: number | null
  archivedUSD: number | null
  archivedRecords: number
  legacyUnknownRecords: number
}

export interface RecordedApiCostSnapshot {
  currencies: TokenCostCurrencySummary[]
  pricedRecords: number
  unpricedRecords: number
  pricedTokens: number
  unpricedTokens: number
  unknownTokenRecords: number
  partialRecords: number
  cacheUnpricedRecords: number
  retainedUSD: number | null
  legacyUnknownRecords: number
  legacyUnknownTokens: number
  legacyUnknownTokenRecords: number
  components: Map<string, ApiComponentCost>
}

export interface FrozenApiCost extends ApiComponentCost {
  pricedRecords: number
  unpricedRecords: number
  partialRecords: number
  cacheUnpricedRecords: number
  pricedTokens?: number
  unpricedTokens?: number
  unknownTokenRecords?: number
}

/** All-zero catalog rows are subscription metadata, not a $0 API price. */
export function positiveCatalogPrices(prices?: PriceTable): PriceTable {
  const table = new Map<string, CatalogPrice[]>()
  if (!prices) return table
  for (const [key, rows] of prices) {
    const positive = rows.filter((row) =>
      row.input > 0 || row.output > 0 || row.cacheRead > 0 || row.cacheWrite > 0)
    if (positive.length) table.set(key, positive)
  }
  return table
}

function unknownCache(record: TokenTelemetryRecord, prices: PriceTable): boolean {
  const counts = record.counts
  if (!counts || !record.providerID || !record.modelID) return false
  const row = selectPrice(prices.get(`${record.providerID}/${record.modelID}`), counts.input + counts.cacheRead)
  if (!row) return false
  return (counts.cacheRead > 0 && row.cacheReadKnown === false) ||
    (counts.cacheWrite > 0 && row.cacheWriteKnown === false)
}

const incompleteCount = (record: TokenTelemetryRecord): boolean =>
  record.partial || record.usageStatus !== "reported" || record.counts === null

const blankApiComponent = (): ApiComponentCost => ({
  currency: "USD", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0,
  pricedRecords: 0, unpricedRecords: 0, cacheUnpricedRecords: 0, partialRecords: 0,
})

/** Per-record frozen API cost; undefined only when the row predates snapshots. */
export function frozenApiCost(record: TokenTelemetryRecord): FrozenApiCost | undefined {
  const snapshot = record.apiPrice
  if (!snapshot) return undefined
  const key = record.providerID && record.modelID ? `${record.providerID}/${record.modelID}` : undefined
  const table = new Map<string, CatalogPrice[]>()
  if (key) {
    const rows = positiveCatalogPrices(new Map([[key, snapshot.prices]])).get(key)
    if (rows) table.set(key, [...rows])
  }
  const base = key ? estimateComponentCosts([record], [], table).get(key) : undefined
  const priced = (base?.pricedRecords ?? 0) > 0
  const counts = record.counts
  const tokens = counts && Number.isSafeInteger(counts.input + counts.output) ? counts.input + counts.output : undefined
  return {
    ...(base ?? blankApiComponent()),
    pricedRecords: priced ? 1 : 0,
    unpricedRecords: priced ? 0 : 1,
    partialRecords: incompleteCount(record) ? 1 : 0,
    cacheUnpricedRecords: key !== undefined && unknownCache(record, table) ? 1 : 0,
    ...(tokens === undefined ? { unknownTokenRecords: 1 } : {
      pricedTokens: priced ? tokens : 0,
      unpricedTokens: priced ? 0 : tokens,
      unknownTokenRecords: 0,
    }),
  }
}

/** Selected raw records only; legacy rows without a snapshot stay unknown. */
export function estimateRecordedApiCosts(records: readonly TokenTelemetryRecord[]): RecordedApiCostSnapshot {
  const components = new Map<string, ApiComponentCost>()
  let pricedRecords = 0
  let unpricedRecords = 0
  let pricedTokens = 0
  let unpricedTokens = 0
  let unknownTokenRecords = 0
  let partialRecords = 0
  let cacheUnpricedRecords = 0
  let legacyUnknownRecords = 0
  let legacyUnknownTokens = 0
  let legacyUnknownTokenRecords = 0
  let usd = 0
  for (const record of records) {
    const cost = frozenApiCost(record)
    if (!cost) {
      legacyUnknownRecords += 1
      const counts = record.counts
      if (counts && Number.isSafeInteger(counts.input + counts.output)) legacyUnknownTokens += counts.input + counts.output
      else legacyUnknownTokenRecords += 1
      continue
    }
    const counts = record.counts
    const tokens = counts && Number.isSafeInteger(counts.input + counts.output) ? counts.input + counts.output : undefined
    if (tokens === undefined) unknownTokenRecords += 1
    if (cost.pricedRecords > 0) {
      pricedRecords += 1
      if (tokens !== undefined) pricedTokens += tokens
      if (Number.isFinite(usd + cost.total)) usd += cost.total
    } else {
      unpricedRecords += 1
      if (tokens !== undefined) unpricedTokens += tokens
    }
    partialRecords += cost.partialRecords
    cacheUnpricedRecords += cost.cacheUnpricedRecords
    if (record.providerID && record.modelID) {
      const key = `${record.providerID}/${record.modelID}`
      const total = components.get(key) ?? blankApiComponent()
      const addMoney = (sum: number, value: number) => Number.isFinite(sum + value) ? sum + value : sum
      total.input = addMoney(total.input, cost.input)
      total.output = addMoney(total.output, cost.output)
      total.cacheRead = addMoney(total.cacheRead, cost.cacheRead)
      total.cacheWrite = addMoney(total.cacheWrite, cost.cacheWrite)
      total.total = addMoney(total.total, cost.total)
      total.pricedRecords += cost.pricedRecords
      total.unpricedRecords += cost.unpricedRecords
      total.partialRecords += cost.partialRecords
      total.cacheUnpricedRecords += cost.cacheUnpricedRecords
      components.set(key, total)
    }
  }
  const pricedTotal = pricedRecords > 0 ? [{
    currency: "USD",
    estimatedAmount: usd,
    estimatedCacheReadSavings: 0,
    cacheSavingsRecords: 0,
    pricedRecords,
    pricedTokens,
    source: "catalog" as const,
    rates: [],
  }] : []
  return {
    currencies: pricedTotal,
    pricedRecords,
    unpricedRecords,
    pricedTokens,
    unpricedTokens,
    unknownTokenRecords,
    partialRecords,
    cacheUnpricedRecords,
    retainedUSD: pricedRecords > 0 ? usd : null,
    legacyUnknownRecords,
    legacyUnknownTokens,
    legacyUnknownTokenRecords,
    components,
  }
}
