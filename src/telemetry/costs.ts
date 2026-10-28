import type { TokenRateConfig } from "../config.ts"
import { selectPrice, type PriceTable } from "./prices.ts"
import type { TokenTelemetryRecord } from "./types.ts"

export interface TokenCostCurrencySummary {
  currency: string
  estimatedAmount: number
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
    unknownTokenRecords,
    // Records priced from a config rate: that rate prices no cache tokens.
    cacheUnpricedRecords,
    currencies: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    // The host's own USD total. Not added to the catalog estimate or to budgets.
    hostReported,
  }
}
