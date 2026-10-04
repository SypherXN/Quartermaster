import type { TokenRateConfig } from "../config.ts"
import type { TokenTelemetryRecord } from "./types.ts"

export interface TokenCostCurrencySummary {
  currency: string
  estimatedAmount: number
  pricedRecords: number
  pricedTokens: number
  rates: TokenRateConfig[]
}

export function estimateTokenCosts(records: readonly TokenTelemetryRecord[], rates: readonly TokenRateConfig[] = []) {
  const byKey = new Map(rates.map((rate) => [
    JSON.stringify([rate.providerID, rate.modelID, rate.variant ?? null]), rate,
  ]))
  const byCurrency = new Map<string, TokenCostCurrencySummary>()
  const usedRates = new Map<string, Set<string>>()
  let pricedRecords = 0
  let pricedTokens = 0
  let unpricedRecords = 0
  let unpricedTokens = 0
  let unknownTokenRecords = 0

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
    const rate = record.providerID && record.modelID
      ? byKey.get(JSON.stringify([record.providerID, record.modelID, record.variant ?? null]))
      : undefined
    if (!rate) {
      addUnpriced(tokens)
      continue
    }
    const amount = (counts.input * rate.inputPerMillion + counts.output * rate.outputPerMillion) / 1_000_000
    const summary = byCurrency.get(rate.currency) ?? {
      currency: rate.currency,
      estimatedAmount: 0,
      pricedRecords: 0,
      pricedTokens: 0,
      rates: [],
    }
    if (!Number.isFinite(amount) || !Number.isFinite(summary.estimatedAmount + amount) ||
      !Number.isSafeInteger(pricedTokens + tokens) ||
      !Number.isSafeInteger(summary.pricedTokens + tokens)) {
      addUnpriced(tokens)
      continue
    }
    pricedRecords += 1
    pricedTokens += tokens
    summary.estimatedAmount += amount
    summary.pricedRecords += 1
    summary.pricedTokens += tokens
    byCurrency.set(rate.currency, summary)
    const key = JSON.stringify([rate.providerID, rate.modelID, rate.variant ?? null])
    const seen = usedRates.get(rate.currency) ?? new Set<string>()
    if (!seen.has(key)) summary.rates.push(rate)
    seen.add(key)
    usedRates.set(rate.currency, seen)
  }

  return {
    status: "estimated-not-billed" as const,
    basis: "input-output-only-per-million" as const,
    complete: false as const,
    pricedRecords,
    pricedTokens,
    unpricedRecords,
    unpricedTokens,
    unknownTokenRecords,
    currencies: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
  }
}
