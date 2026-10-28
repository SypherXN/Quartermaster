import { access } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { registerAgentRouting } from "./agent-routing.ts"
import { parseConfig, type TokenRateConfig } from "./config.ts"
import { ModuleCooldowns } from "./modules.ts"
import { adoptProjectQuartermasterOptions, type ConfigurationReader } from "./project-options.ts"
import { readUsageStatus, type UsageReadResult } from "./usage.ts"
import { registerQuartermasterRpc } from "./rpc.ts"
import { startTokenCollector } from "./telemetry/collector.ts"
import { ProviderErrorLedger, startProviderErrorCollector } from "./telemetry/errors.ts"
import { TokenLedger } from "./telemetry/ledger.ts"
import { TokenBudgetGate } from "./telemetry/budget-gate.ts"
import type { TokenBudgetPricing } from "./telemetry/budgets.ts"
import { readPriceTable } from "./telemetry/prices.ts"
import { PluginAttributionLedger } from "./telemetry/attribution.ts"
import { CompactionLedger } from "./telemetry/compaction.ts"
import { DirectUsageLedger } from "./telemetry/direct-usage.ts"
import { WindowLedger } from "./telemetry/window.ts"

function startupConfigurationReader(ctx: object): ConfigurationReader | undefined {
  const reader = (ctx as { quartermasterConfigurationReader?: unknown }).quartermasterConfigurationReader
  return typeof reader === "function" ? reader as ConfigurationReader : undefined
}

type LocalUiStarter = {
  ensureLocalUi?: (options: {
    projectDirectory: string
    retain?: (stop: () => void) => void
  }) => Promise<unknown>
  localUiOwnerCount?: () => number
  releaseLocalUi?: () => void
}

export async function startCheckoutLocalUi(directory: string | undefined, options: {
  env?: NodeJS.ProcessEnv
  scriptUrl?: URL
  load?: (script: URL) => Promise<LocalUiStarter>
  retain?: (stop: () => void) => void
} = {}): Promise<string> {
  const env = options.env ?? process.env
  if (typeof directory !== "string" || directory.trim() === "") return "skipped"
  if (env.QUARTERMASTER_LOCAL_UI === "0") return "disabled"
  const script = options.scriptUrl ?? new URL("./local-ui.mjs", import.meta.url)
  try {
    await access(fileURLToPath(script))
  } catch {
    return "absent"
  }
  try {
    const load = options.load ?? ((url: URL) => import(url.href) as Promise<LocalUiStarter>)
    const loaded = await load(script)
    if (typeof loaded.ensureLocalUi !== "function") return "absent"
    const status = await loaded.ensureLocalUi({
      projectDirectory: directory,
      ...(typeof options.retain === "function" ? { retain: options.retain } : {}),
    })
    if (status === "started") {
      const port = env.QUARTERMASTER_LOCAL_UI_PORT ?? "4175"
      console.info(`[quartermaster] local UI at http://127.0.0.1:${port}/`)
    }
    if (status === "started" || status === "running" || status === "skipped" || status === "disabled") return status
    return "unavailable"
  } catch (error) {
    console.warn(`[quartermaster] local UI unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return "unavailable"
  }
}

type CatalogModelList = Parameters<typeof readPriceTable>[0]

async function readBudgetPricing(
  tokenRates: readonly TokenRateConfig[],
  ctx: { model: { list: () => Promise<unknown> } },
): Promise<TokenBudgetPricing> {
  try {
    const list = ctx.model.list.bind(ctx.model) as CatalogModelList
    return { rates: tokenRates, prices: await readPriceTable(list) }
  } catch {
    return { rates: tokenRates }
  }
}

function startupLocalUi(ctx: object): (
  directory: string | undefined,
  options?: { retain?: (stop: () => void) => void },
) => Promise<unknown> {
  const hook = (ctx as { quartermasterLocalUi?: unknown }).quartermasterLocalUi
  return typeof hook === "function"
    ? hook as (directory: string | undefined, options?: { retain?: (stop: () => void) => void }) => Promise<unknown>
    : startCheckoutLocalUi
}

export default Plugin.define({
  id: "quartermaster",
  async setup(ctx) {
    if (ctx.options && typeof ctx.options === "object" && !Array.isArray(ctx.options) && Object.keys(ctx.options).length > 0)
      throw new Error("Quartermaster settings belong in quartermaster.jsonc beside the OpenCode config that registers the plugin, not in plugins[].options")
    const config = parseConfig({})
    const readConfiguration = startupConfigurationReader(ctx)
    const directory = ctx.location.directory
    let stopLocalUi: (() => void) | undefined
    const stopUi = () => {
      const stop = stopLocalUi
      stopLocalUi = undefined
      stop?.()
    }
    try {
      await startupLocalUi(ctx)(directory, { retain: (stop) => { stopLocalUi = stop } })
    } catch (error) {
      console.warn(`[quartermaster] local UI unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    let hostReady = false
    try {
      let configurationError: unknown
      if (directory) {
        try {
          await adoptProjectQuartermasterOptions(config, directory, readConfiguration)
        } catch (error) {
          configurationError = error
          console.warn(`[quartermaster] project configuration unavailable: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const ledger = new TokenLedger(ctx.storage)
      const errorLedger = new ProviderErrorLedger(ctx.storage)
      const attributionLedger = new PluginAttributionLedger(ctx.storage)
      const directUsageLedger = new DirectUsageLedger(ctx.storage)
      const compactionLedger = new CompactionLedger(ctx.storage)
      const windowLedger = new WindowLedger(ctx.storage)
      const projectID = ctx.location.project.id
      const modules = await ModuleCooldowns.load(config, ctx.storage, projectID, Date.now,
        directory ? () => adoptProjectQuartermasterOptions(config, directory, readConfiguration) : undefined,
        () => readUsageStatus(ctx))
      if (configurationError) modules.noteConfigurationFailure(configurationError)
      const budgetGate = config.budgets?.length
        ? new TokenBudgetGate(
          config.budgets,
          projectID,
          await ledger.list({ projectID }),
          await readBudgetPricing(config.tokenRates ?? [], ctx),
        )
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
          directUsageLedger,
          compactionLedger,
          windowLedger,
          budgets: config.budgets,
          tokenRates: config.tokenRates,
        }, ctx.location.directory, undefined, modules)
        const collector = startTokenCollector(ctx, ledger, async () => {
          if (!budgetGate) return
          const changed = await budgetGate.refresh(
            await ledger.list({ projectID }),
            await readBudgetPricing(config.tokenRates ?? [], ctx),
          )
          if (changed) await routing?.refreshBudgets()
        }, compactionLedger, windowLedger)
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
        const shutdown = async () => {
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
        hostReady = true
        return async () => {
          try {
            await shutdown()
          } finally {
            stopUi()
          }
        }
      } catch (error) {
        await routing?.dispose()
        throw error
      }
    } finally {
      if (!hostReady) stopUi()
    }
  },
})
