import { access } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { Service } from "@opencode/client/service"
import { registerAgentRouting } from "./agent-routing.ts"
import { parseConfig, type TokenRateConfig } from "./config.ts"
import { ModuleCooldowns } from "./modules.ts"
import { adoptProjectQuartermasterOptions, receivingProcessEndpoint, type ConfigurationReader } from "./project-options.ts"
import { readUsageStatus, type UsageReadResult } from "./usage.ts"
import { registerQuartermasterRpc } from "./rpc.ts"
import { startTokenCollector } from "./telemetry/collector.ts"
import { ProviderErrorLedger, startProviderErrorCollector } from "./telemetry/errors.ts"
import { TokenLedger } from "./telemetry/ledger.ts"
import { TokenBudgetGate } from "./telemetry/budget-gate.ts"
import type { TokenBudgetPricing } from "./telemetry/budgets.ts"
import { readCatalogSnapshot, readPriceTable, readQuotaPriceTable } from "./telemetry/prices.ts"
import { PluginAttributionLedger } from "./telemetry/attribution.ts"
import { CompactionLedger } from "./telemetry/compaction.ts"
import { DirectUsageLedger } from "./telemetry/direct-usage.ts"
import { WindowLedger } from "./telemetry/window.ts"
import { QuotaValueTracker } from "./quota-values.ts"

function startupConfigurationReader(ctx: object): ConfigurationReader | undefined {
  const reader = (ctx as { quartermasterConfigurationReader?: unknown }).quartermasterConfigurationReader
  return typeof reader === "function" ? reader as ConfigurationReader : undefined
}

type LocalUiStarter = {
  ensureLocalUi?: (options: {
    projectDirectory: string
    retain?: (stop: () => void) => void
    hostEndpoint?: { url: string; auth?: { type: "basic"; username: string; password: string } }
  }) => Promise<unknown>
  localUiOwnerCount?: () => number
  releaseLocalUi?: () => void
}

type HostEndpoint = { url: string; auth?: { type: "basic"; username: string; password: string } }

// The receiving server's password only exists in the environment it was
// launched with, so the value here is a guess until the server confirms it.
// Verify before handing it to the UI: an unchecked guess fails later, in the
// page, as an unexplained 401. Only variable names are reported, never values.
async function verifiedHostEndpoint(
  own: { url: string },
  env: NodeJS.ProcessEnv,
  discover: () => Promise<HostEndpoint | undefined>,
): Promise<HostEndpoint> {
  // OpenChamber injects its managed password under a version-dependent name, so
  // match by name instead of trusting one spelling. Values are never reported.
  const passwords = [...new Set([
    env.OPENCODE_PASSWORD,
    env.OPENCODE_SERVER_PASSWORD,
    ...Object.entries(env)
      .filter(([name]) => /PASSWORD$/i.test(name) && /OPENCODE|OPENCHAMBER/i.test(name))
      .map(([, value]) => value),
  ].filter((value): value is string => typeof value === "string" && value.trim() !== ""))]

  for (const password of passwords) {
    const endpoint: HostEndpoint = { ...own, auth: { type: "basic", username: "opencode", password } }
    if (await hostAccepts(endpoint.url, endpoint.auth)) return endpoint
  }

  // OpenChamber proxies its own host under its origin and adds the credential
  // itself, so it answers /api/info from localhost with nothing attached. That
  // is the same host this session runs on, which is what the page should read.
  const port = env.OPENCHAMBER_PORT?.trim()
  const proxies = [...new Set([
    env.OPENCHAMBER_URL?.trim(),
    /^\d+$/.test(port ?? "") ? `http://127.0.0.1:${port}` : undefined,
    "http://127.0.0.1:57123", // ponytail: OpenChamber's default port; env values above win
  ].filter((url): url is string => typeof url === "string" && url !== ""))]
  for (const url of proxies) {
    if (await hostAccepts(url, undefined)) {
      console.warn(`[quartermaster] receiving host credentials unavailable; local UI reads the host through ${url} instead`)
      return { url }
    }
  }

  // No usable credential: the receiving process answers 401 to everything, so
  // reading it would only produce a permanently disconnected page. The
  // registered service carries its own credential, so prefer a working page.
  try {
    const discovered = await discover()
    if (discovered && await hostAccepts(discovered.url, discovered.auth)) {
      console.warn("[quartermaster] receiving host credentials unavailable; local UI reads the registered OpenCode service instead")
      return { url: discovered.url, ...(discovered.auth ? { auth: discovered.auth } : {}) }
    }
  } catch {
    // Discovery is best effort; the receiving endpoint below is the last resort.
  }

  console.warn(`[quartermaster] host credentials unverified (${passwords.length ? "environment values rejected" : "no environment values"}); the page may report 401`)
  const fallback = passwords[0]
  return { ...own, ...(fallback ? { auth: { type: "basic" as const, username: "opencode", password: fallback } } : {}) }
}

async function hostAccepts(url: string, auth: HostEndpoint["auth"]): Promise<boolean> {
  try {
    const response = await fetch(new URL("/api/info", url), {
      headers: { ...Service.headers({ url, auth }), accept: "application/json" },
      signal: AbortSignal.timeout(1_500),
    })
    if (!response.ok) return false
    const info = await response.json() as { pid?: unknown }
    return typeof info?.pid === "number"
  } catch {
    return false
  }
}

export async function startCheckoutLocalUi(directory: string | undefined, options: {
  env?: NodeJS.ProcessEnv
  argv?: readonly string[]
  scriptUrl?: URL
  load?: (script: URL) => Promise<LocalUiStarter>
  retain?: (stop: () => void) => void
  discover?: () => Promise<HostEndpoint | undefined>
} = {}): Promise<string> {
  const env = options.env ?? process.env
  if (typeof directory !== "string" || directory.trim() === "") return "skipped"
  if (env.QUARTERMASTER_LOCAL_UI === "0") return "disabled"
  const script = options.scriptUrl ?? new URL("./local-ui.mjs", import.meta.url)
  try {
    await access(fileURLToPath(script))
  } catch {
    // tsc does not emit this .mjs, so a stale or partial dist lands here. Say
    // which path is missing instead of skipping the page silently.
    console.warn(`[quartermaster] local UI script missing: ${fileURLToPath(script)}`)
    return "absent"
  }
  try {
    const load = options.load ?? ((url: URL) => import(url.href) as Promise<LocalUiStarter>)
    const loaded = await load(script)
    if (typeof loaded.ensureLocalUi !== "function") return "absent"
    const own = receivingProcessEndpoint({ argv: options.argv ?? process.argv, env })
    const hostEndpoint = own
      ? await verifiedHostEndpoint(own, env, options.discover ?? (() => Service.discover() as Promise<HostEndpoint | undefined>))
      : undefined
    const status = await loaded.ensureLocalUi({
      projectDirectory: directory,
      ...(hostEndpoint ? { hostEndpoint } : {}),
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
      const quotaValues = new QuotaValueTracker(config)
      const quotaPriceFor = async (providerID: string, modelID: string) => {
        const list = ctx.model.list.bind(ctx.model) as CatalogModelList
        const table = await readQuotaPriceTable(list, Date.now, {
          fetchApiPrices: config.fetchApiPrices,
          wait: false,
          fetch: globalThis.fetch,
        })
        return table.get(`${providerID}/${modelID}`)
      }
      const ledger = new TokenLedger(ctx.storage, {
        onRemove: (records) => quotaValues.removeTokenRecords(records),
        apiPrice: quotaPriceFor,
      })
      const errorLedger = new ProviderErrorLedger(ctx.storage)
      const attributionLedger = new PluginAttributionLedger(ctx.storage)
      const directUsageLedger = new DirectUsageLedger(ctx.storage, { apiPrice: quotaPriceFor })
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
      const routing = await registerAgentRouting(ctx, config, usage, budgetGate, readConfiguration, quotaValues, globalThis.fetch)
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
          catalog: async () => {
            const list = ctx.model.list.bind(ctx.model) as CatalogModelList
            const snapshot = await readCatalogSnapshot(list)
            const quotaPrices = await readQuotaPriceTable(list, Date.now, {
              fetchApiPrices: config.fetchApiPrices,
              wait: false,
              fetch: globalThis.fetch,
            })
            return { ...snapshot, quotaPrices }
          },
        }, ctx.location.directory, undefined, modules)
        const collector = startTokenCollector(ctx, ledger, async () => {
          if (!budgetGate) return
          const changed = await budgetGate.refresh(
            await ledger.list({ projectID }),
            await readBudgetPricing(config.tokenRates ?? [], ctx),
          )
          if (changed) await routing?.refreshBudgets()
        }, compactionLedger, windowLedger, projectID, (record) => quotaValues.addTokenRecord(record))
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
