import type { TokenBudgetConfig } from "../config.ts"
import { evaluateTokenBudgets, type TokenBudgetReading } from "./budgets.ts"
import type { TokenTelemetryRecord } from "./types.ts"

export type TokenBudgetReason =
  | ({ code: "budget-limit-reached" } & TokenBudgetReading)
  | ({ code: "budget-usage-unknown" } & TokenBudgetReading)
  | ({ code: "cannot-guarantee-hard-cap" } & TokenBudgetReading)

export class TokenBudgetGate {
  private records: readonly TokenTelemetryRecord[]
  private readonly budgets: readonly TokenBudgetConfig[] | undefined
  private readonly projectID: string

  constructor(
    budgets: readonly TokenBudgetConfig[] | undefined,
    projectID: string,
    records: readonly TokenTelemetryRecord[] = [],
  ) {
    this.budgets = budgets
    this.projectID = projectID
    this.records = records
  }

  update(records: readonly TokenTelemetryRecord[]): boolean {
    const previous = JSON.stringify(this.reasons(Date.now()))
    this.records = records
    return previous !== JSON.stringify(this.reasons(Date.now()))
  }

  reasons(now: number): TokenBudgetReason[] {
    const reasons: TokenBudgetReason[] = []
    for (const reading of evaluateTokenBudgets(this.budgets, this.records, now, this.projectID)) {
      const config = this.budgets?.find(({ id }) => id === reading.id)
      if (config?.mode === "strict") {
        reasons.push({ code: "cannot-guarantee-hard-cap", ...reading })
        continue
      }
      if (reading.limitReached) reasons.push({ code: "budget-limit-reached", ...reading })
      if (reading.unknownRecords > 0) reasons.push({ code: "budget-usage-unknown", ...reading })
    }
    return reasons
  }
}
