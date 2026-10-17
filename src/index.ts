import { Plugin } from "@opencode/plugin"
import { registerAgentRouting } from "./agent-routing.ts"
import { parseConfig } from "./config.ts"
import { ModuleCooldowns } from "./modules.ts"
import { adoptProjectQuartermasterOptions, type ConfigurationReader } from "./project-options.ts"
import { readUsageStatus, type UsageReadResult } from "./usage.ts"
import { registerQuartermasterRpc } from "./rpc.ts"
import { startTokenCollector } from "./telemetry/collector.ts"
import { ProviderErrorLedger, startProviderErrorCollector } from "./telemetry/errors.ts"
import { TokenLedger } from "./telemetry/ledger.ts"
import { TokenBudgetGate } from "./telemetry/budget-gate.ts"
import { PluginAttributionLedger } from "./telemetry/attribution.ts"

function startupConfigurationReader(ctx: object): ConfigurationReader | undefined {
  const reader = (ctx as { quartermasterConfigurationReader?: unknown }).quartermasterConfigurationReader
  return typeof reader === "function" ? reader as ConfigurationReader : undefined
}

export default Plugin.define({
  id: "quartermaster",
  async setup(ctx) {
    if (ctx.options && typeof ctx.options === "object" && !Array.isArray(ctx.options) && Object.keys(ctx.options).length > 0)
      throw new Error("Quartermaster settings belong in quartermaster.jsonc beside the OpenCode config that registers the plugin, not in plugins[].options")
    const config = parseConfig({})
    const readConfiguration = startupConfigurationReader(ctx)
    if (ctx.location.directory) await adoptProjectQuartermasterOptions(config, ctx.location.directory, readConfiguration).catch(() => undefined)
    const ledger = new TokenLedger(ctx.storage)
    const errorLedger = new ProviderErrorLedger(ctx.storage)
    const attributionLedger = new PluginAttributionLedger(ctx.storage)
    const projectID = ctx.location.project.id
    const modules = await ModuleCooldowns.load(config, ctx.storage, projectID, Date.now,
      ctx.location.directory ? () => adoptProjectQuartermasterOptions(config, ctx.location.directory, readConfiguration) : undefined,
      () => readUsageStatus(ctx))
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
    const routing = await registerAgentRouting(ctx, config, usage, budgetGate, readConfiguration)
    try {
      const rpc = await registerQuartermasterRpc(ctx, config, routing, usage, {
        projectID,
        tokenLedger: ledger,
        errorLedger,
        attributionLedger,
        budgets: config.budgets,
        tokenRates: config.tokenRates,
      }, ctx.location.directory, undefined, modules)
      const collector = startTokenCollector(ctx, ledger, async () => {
        if (!budgetGate) return
        const changed = budgetGate.update(await ledger.list({ projectID }))
        if (changed) await routing?.refreshBudgets()
      })
      let errorCollector
      try {
        errorCollector = typeof ctx.session?.hook === "function"
          ? await startProviderErrorCollector(ctx, errorLedger)
          : undefined
      } catch (error) {
        await collector.dispose()
        await rpc.dispose()
        throw error
      }
      return async () => {
        try {
          await errorCollector?.dispose()
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
