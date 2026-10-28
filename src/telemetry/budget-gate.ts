import type { TokenBudgetConfig } from "../config.ts"
import { evaluateTokenBudgets, type TokenBudgetPricing, type TokenBudgetReading } from "./budgets.ts"
import type { TokenTelemetryRecord } from "./types.ts"

export type TokenBudgetReason =
  | ({ code: "budget-limit-reached" } & TokenBudgetReading)
  | ({ code: "budget-usage-unknown" } & TokenBudgetReading)
  | ({ code: "budget-cost-reached" } & TokenBudgetReading)
  | ({ code: "budget-cost-unknown" } & TokenBudgetReading)
  | ({ code: "cannot-guarantee-hard-cap" } & TokenBudgetReading)

export class TokenBudgetGate {
  private records: readonly TokenTelemetryRecord[]
  private readonly budgets: readonly TokenBudgetConfig[] | undefined
  private readonly projectID: string
  private pricing?: TokenBudgetPricing

  constructor(
    budgets: readonly TokenBudgetConfig[] | undefined,
    projectID: string,
    records: readonly TokenTelemetryRecord[] = [],
    pricing?: TokenBudgetPricing,
  ) {
    this.budgets = budgets
    this.projectID = projectID
    this.records = records
    this.pricing = pricing
  }

  setPricing(pricing?: TokenBudgetPricing): void {
    this.pricing = pricing
  }

  update(records: readonly TokenTelemetryRecord[]): boolean {
    const previous = JSON.stringify(this.reasons(Date.now()))
    this.records = records
    return previous !== JSON.stringify(this.reasons(Date.now()))
  }

  async refresh(
    records: readonly TokenTelemetryRecord[],
    pricing?: TokenBudgetPricing,
  ): Promise<boolean> {
    if (pricing !== undefined) this.pricing = pricing
    return this.update(records)
  }

  reasons(now: number): TokenBudgetReason[] {
    const reasons: TokenBudgetReason[] = []
    for (const reading of evaluateTokenBudgets(
      this.budgets,
      this.records,
      now,
      this.projectID,
      this.pricing,
    )) {
      const config = this.budgets?.find(({ id }) => id === reading.id)
      if (config?.mode === "strict") {
        reasons.push({ code: "cannot-guarantee-hard-cap", ...reading })
        continue
      }
      if (reading.limitTokens !== null && reading.observedTokens >= reading.limitTokens) {
        reasons.push({ code: "budget-limit-reached", ...reading })
      }
      if (reading.limitUSD !== null && reading.usedUSD !== null && reading.usedUSD >= reading.limitUSD) {
        reasons.push({ code: "budget-cost-reached", ...reading })
      }
      if (reading.costUnknown) reasons.push({ code: "budget-cost-unknown", ...reading })
      if (reading.unknownRecords > 0) reasons.push({ code: "budget-usage-unknown", ...reading })
    }
    return reasons
  }
}
