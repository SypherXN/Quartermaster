import { Plugin } from "@opencode/plugin"
import { registerAgentRouting } from "./agent-routing.ts"
import { parseConfig } from "./config.ts"
import { adoptProjectQuartermasterOptions } from "./project-options.ts"
import { readUsageStatus, type UsageReadResult } from "./usage.ts"
import { registerQuartermasterRpc } from "./rpc.ts"
import { startTokenCollector } from "./telemetry/collector.ts"
import { ProviderErrorLedger, startProviderErrorCollector } from "./telemetry/errors.ts"
import { TokenLedger } from "./telemetry/ledger.ts"
import { TokenBudgetGate } from "./telemetry/budget-gate.ts"
import { PluginAttributionLedger } from "./telemetry/attribution.ts"

export default Plugin.define({
  id: "quartermaster",
  async setup(ctx) {
    const config = parseConfig(ctx.options)
    if (ctx.location.directory) await adoptProjectQuartermasterOptions(config, ctx.location.directory).catch(() => undefined)
    const ledger = new TokenLedger(ctx.storage)
    const errorLedger = new ProviderErrorLedger(ctx.storage)
    const attributionLedger = new PluginAttributionLedger(ctx.storage)
    const projectID = ctx.location.project.id
    const budgetGate = config.budgets?.length
      ? new TokenBudgetGate(config.budgets, projectID, await ledger.list({ projectID }))
      : undefined
    let usage: UsageReadResult | undefined
    if (Object.keys(config.usageSources).length > 0) {
      usage = await readUsageStatus(ctx)
      if (usage.status === "unavailable") {
        console.warn(`[quartermaster] opencode-usage status unavailable: ${usage.reason}`)
      }
    }
    const routing = await registerAgentRouting(ctx, config, usage, budgetGate)
    try {
      const rpc = await registerQuartermasterRpc(ctx, config, routing, usage, {
        projectID,
        tokenLedger: ledger,
        errorLedger,
        attributionLedger,
        budgets: config.budgets,
        tokenRates: config.tokenRates,
      }, ctx.location.directory)
      const collector = startTokenCollector(ctx, ledger, async () => {
        if (!budgetGate) return
        const changed = budgetGate.update(await ledger.list({ projectID }))
        if (changed) await routing?.refreshBudgets()
      })
      let errorCollector
      try {
        errorCollector = await startProviderErrorCollector(ctx, errorLedger)
      } catch (error) {
        await collector.dispose()
        await rpc.dispose()
        throw error
      }
      return async () => {
        try {
          await errorCollector.dispose()
        } finally {
          try {
            await rpc.dispose()
          } finally {
            try {
              await collector.dispose()
            } finally {
              await routing?.dispose()
            }
          }
        }
      }
    } catch (error) {
      await routing?.dispose()
      throw error
    }
  },
})
