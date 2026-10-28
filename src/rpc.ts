import { Rpc } from "@opencode/plugin/rpc"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { QuartermasterConfig } from "./config.ts"
import type { FailureReport, SuccessReport } from "./failures.ts"
import { ModuleConfigurationUnavailable, type ModuleCooldowns, type ModuleCooldownReport, type ModuleSelection } from "./modules.ts"
import type { registerAgentRouting } from "./agent-routing.ts"
import type { UsageReadResult, UsageSourceID } from "./usage.ts"
import type { TokenBudgetConfig } from "./config.ts"
import type { ProviderErrorLedger } from "./telemetry/errors.ts"
import type { TokenLedger } from "./telemetry/ledger.ts"
import { MAX_ATTRIBUTION_SESSIONS, type PluginAttributionLedger } from "./telemetry/attribution.ts"
import type { CompactionLedger } from "./telemetry/compaction.ts"
import type { WindowLedger } from "./telemetry/window.ts"
import { type DirectUsageLedger } from "./telemetry/direct-usage.ts"
import { buildQuartermasterReport, REPORT_MAX_OFFSET, REPORT_MAX_PAGE_SIZE, type QuartermasterReport, type ReportQuery } from "./telemetry/report.ts"
import { readCatalogSnapshot, type CatalogSnapshot } from "./telemetry/prices.ts"
import { applyProjectQuartermasterOptions, readProjectQuartermasterOptions, readNativeConfiguration, type ConfigurationReader } from "./project-options.ts"

type AgentRouting = NonNullable<Awaited<ReturnType<typeof registerAgentRouting>>>

export const QUARTERMASTER_API_VERSION = 1 as const
export type ReportingServices = {
  projectID: string
  tokenLedger: TokenLedger
  errorLedger: ProviderErrorLedger
  attributionLedger: PluginAttributionLedger
  directUsageLedger?: DirectUsageLedger
  compactionLedger?: CompactionLedger
  windowLedger?: WindowLedger
  budgets: readonly TokenBudgetConfig[] | undefined
  tokenRates: QuartermasterConfig["tokenRates"]
  plans?: QuartermasterConfig["plans"]
  catalog?: () => Promise<CatalogSnapshot>
  now?: () => number
}

const string = { type: "string" }
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
})
const output = { type: "object", additionalProperties: true }
const errors = {
  invalid_input: object({ path: string, message: string }, ["path", "message"]),
  unavailable: object({ reason: string }, ["reason"]),
}
const model = object({ providerID: string, modelID: string, variant: string }, ["providerID", "modelID"])

export const QUARTERMASTER_RPC = Rpc.define({
  id: "quartermaster",
  methods: {
    selectModule: { input: object({ module: string }, ["module"]), output, errors },
    reportModuleCooldown: {
      input: object({ module: string, providerID: string, modelID: string,
        reason: { type: "string", enum: ["rate-limit", "temporary-unavailable"] } },
      ["module", "providerID", "modelID", "reason"]), output, errors,
    },
    select: { input: object({ agent: string, workType: string }, ["agent"]), output, errors: { invalid_input: errors.invalid_input } },
    selectPlan: { input: object({ plan: string }, ["plan"]), output, errors: { invalid_input: errors.invalid_input } },
    explain: { input: object({ agent: string }, ["agent"]), output, errors: { invalid_input: errors.invalid_input } },
    status: { input: object({}), output },
    diagnoseSession: { input: object({ sessionID: string }, ["sessionID"]), output, errors },
    report: {
      input: object({
        projectID: string,
        since: { type: "integer" },
        until: { type: "integer" },
        limit: { type: "integer", minimum: 1, maximum: REPORT_MAX_PAGE_SIZE },
        offset: { type: "integer", minimum: 0, maximum: REPORT_MAX_OFFSET },
        refresh: { type: "boolean" },
      }),
      output,
      errors: { invalid_input: errors.invalid_input },
    },
    readOptions: { input: object({}), output, errors },
    applyOptions: {
      input: object({ options: { type: "object", additionalProperties: true }, revision: { type: "number" } }, ["options", "revision"]),
      output,
      errors,
    },
    reportPluginUsage: {
      input: object({
        pluginID: string,
        pluginName: string,
        sessionIDs: { type: "array", items: string, minItems: 1, maxItems: MAX_ATTRIBUTION_SESSIONS },
      }, ["pluginID", "pluginName", "sessionIDs"]),
      output,
      errors: { invalid_input: errors.invalid_input },
    },
    reportDirectUsage: {
      input: object({
        pluginID: string,
        pluginName: string,
        usageID: string,
        providerID: string,
        modelID: string,
        variant: string,
        counts: object({
          input: { type: "integer", minimum: 0 },
          output: { type: "integer", minimum: 0 },
          reasoning: { type: "integer", minimum: 0 },
          cacheRead: { type: "integer", minimum: 0 },
          cacheWrite: { type: "integer", minimum: 0 },
        }, ["input", "output"]),
      }, ["pluginID", "pluginName", "usageID", "providerID", "modelID", "counts"]),
      output,
      errors: { invalid_input: errors.invalid_input },
    },
    pin: { input: object({ agent: string, model }, ["agent", "model"]), output, errors },
    unpin: { input: object({ agent: string }), output, errors },
    reportFailure: {
      input: object({
        providerID: string,
        classification: { type: "string", enum: ["provider-outage", "model-outage", "temporary-rate-limit", "quota-exhausted", "auth", "cancelled", "other"] },
        modelID: string,
      }, ["providerID", "classification"]),
      output, errors,
    },
    reportSuccess: {
      input: object({ providerID: string, scope: { type: "string", enum: ["provider", "model"] }, modelID: string }, ["providerID", "scope"]),
      output, errors,
    },
  },
  events: {},
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export type SelectionInput = { agent: string; workType?: string }

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
function moduleInput(input: unknown, report: true): input is Record<string, unknown> & ModuleCooldownReport
function moduleInput(input: unknown, report: false): input is Record<string, unknown> & { module: string }
function moduleInput(input: unknown, report: boolean): input is Record<string, unknown> & { module: string } {
  const keys = report ? ["module", "providerID", "modelID", "reason"] : ["module"]
  return isRecord(input) && Object.keys(input).every(key => keys.includes(key)) && nonempty(input.module) &&
    (!report || (nonempty(input.providerID) && nonempty(input.modelID) &&
      (input.reason === "rate-limit" || input.reason === "temporary-unavailable")))
}
const validModel = (value: unknown): value is Record<string, unknown> => isRecord(value) &&
  nonempty(value.providerID) && nonempty(value.modelID) && (value.variant === undefined || nonempty(value.variant))
const sameModel = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  a.providerID === b.providerID && a.modelID === b.modelID && a.variant === b.variant

type ModuleUnavailable = { status: "unavailable"; reasonCode: "timeout" | "cancelled" | "service-unavailable" | "invalid-response" | "invalid-input" }
export type SafeModuleSelectionResult = ({ apiVersion: 1 } & ModuleSelection) | ModuleUnavailable
export type ModuleCooldownAcknowledgement = { apiVersion: 1 } & Awaited<ReturnType<ModuleCooldowns["report"]>>
export type SafeModuleCooldownResult = ModuleCooldownAcknowledgement | (ModuleUnavailable & { accepted: false })

function moduleCandidate(candidate: Record<string, unknown>, evaluatedAt: number): boolean {
  if (!validModel(candidate) || candidate.health !== "unknown") return false
  if (candidate.quota !== "unknown" && candidate.quota !== "available" && candidate.quota !== "limited") return false
  if (candidate.reason === "cooldown") {
    return timestamp(candidate.blockedUntil) && candidate.blockedUntil > evaluatedAt &&
      candidate.remainingMs === candidate.blockedUntil - evaluatedAt
  }
  if (candidate.blockedUntil !== undefined || candidate.remainingMs !== undefined) return false
  if (candidate.reason === "declared") return candidate.quota === "unknown" || candidate.quota === "available"
  if (candidate.reason === "limited") return candidate.quota === "limited"
  return candidate.reason === "usage-unavailable" && candidate.quota === "unknown"
}

function validModuleSelection(value: unknown, module: string): boolean {
  if (!isRecord(value) || value.apiVersion !== 1 || value.module !== module || !timestamp(value.evaluatedAt) || !Array.isArray(value.candidates)) return false
  const candidates = value.candidates
  const seen = new Set<string>()
  let earliest = Infinity
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !moduleCandidate(candidate, value.evaluatedAt)) return false
    const key = JSON.stringify([candidate.providerID, candidate.modelID])
    if (seen.has(key)) return false
    seen.add(key)
    if (candidate.reason === "cooldown") earliest = Math.min(earliest, candidate.blockedUntil as number)
  }
  const first = candidates.find(candidate => isRecord(candidate) && candidate.reason === "declared")
  const nextEligibleAt = Number.isFinite(earliest) ? earliest : undefined
  if (value.status === "selected") return !!first && isRecord(first) && validModel(value.selected) && sameModel(first, value.selected) && value.nextEligibleAt === undefined
  if (value.selected !== undefined) return false
  if (value.status === "no-module") return candidates.length === 0 && value.nextEligibleAt === undefined
  return value.status === "no-eligible" && candidates.length > 0 && !first && value.nextEligibleAt === nextEligibleAt
}

async function moduleRequest(
  invoke: (signal: AbortSignal) => Promise<unknown>, validate: (value: unknown) => boolean,
  timeoutMs: number, signal?: AbortSignal,
): Promise<unknown> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return { status: "unavailable", reasonCode: "invalid-input" }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let reasonCode: ModuleUnavailable["reasonCode"] = "service-unavailable"
  let abort = () => {}
  try {
    if (signal?.aborted) return { status: "unavailable", reasonCode: "cancelled" }
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => { reasonCode = "cancelled"; controller.abort(); reject(new Error("cancelled")) }
      signal?.addEventListener("abort", abort, { once: true })
      timer = setTimeout(() => { reasonCode = "timeout"; controller.abort(); reject(new Error("timeout")) }, timeoutMs)
    })
    const result = await Promise.race([invoke(controller.signal), cancelled])
    if (controller.signal.aborted) return { status: "unavailable", reasonCode }
    return validate(result) ? result : { status: "unavailable", reasonCode: "invalid-response" }
  } catch {
    return { status: "unavailable", reasonCode }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

export async function requestModuleSelection(
  ctx: Pick<Context, "rpc">, input: { module: string }, timeoutMs = 2_000, signal?: AbortSignal,
): Promise<SafeModuleSelectionResult> {
  if (!moduleInput(input, false)) return { status: "unavailable", reasonCode: "invalid-input" }
  return await moduleRequest(
    signal => ctx.rpc(QUARTERMASTER_RPC).selectModule(input, { signal }),
    value => validModuleSelection(value, input.module), timeoutMs, signal,
  ) as SafeModuleSelectionResult
}

export async function reportModuleCooldown(
  ctx: Pick<Context, "rpc">, input: ModuleCooldownReport, timeoutMs = 2_000, signal?: AbortSignal,
): Promise<SafeModuleCooldownResult> {
  if (!moduleInput(input, true)) return { status: "unavailable", accepted: false, reasonCode: "invalid-input" }
  const result = await moduleRequest(
    signal => ctx.rpc(QUARTERMASTER_RPC).reportModuleCooldown(input, { signal }),
    value => isRecord(value) && value.apiVersion === 1 && (
      value.accepted === false && ["unknown-module", "unknown-model"].includes(String(value.reason)) ||
      value.accepted === true && value.module === input.module && value.providerID === input.providerID &&
      value.modelID === input.modelID && timestamp(value.blockedUntil) && value.blockedUntil > 0
    ), timeoutMs, signal,
  )
  return isRecord(result) && result.status === "unavailable"
    ? { ...result, accepted: false } as SafeModuleCooldownResult
    : result as SafeModuleCooldownResult
}

type SelectionMetadata = {
  apiVersion: typeof QUARTERMASTER_API_VERSION
  reasonCode: string
  reason: string
  skipped: unknown[]
  [key: string]: unknown
}

export type SafeSelectionResult =
  | ({
      status: "selected"
      selected: { providerID: string; modelID: string; variant?: string }
    } & SelectionMetadata)
  | ({ status: "no-plan" | "no-eligible" } & SelectionMetadata)
  | {
      status: "unavailable"
      reasonCode: "service-unavailable" | "timeout" | "invalid-response"
      reason: string
    }

export async function requestSelection(
  ctx: Pick<Context, "rpc">,
  input: SelectionInput,
  timeoutMs = 2_000,
): Promise<SafeSelectionResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    const result = await Promise.race([
      ctx.rpc(QUARTERMASTER_RPC).select(input, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          controller.abort()
          reject(new Error("Quartermaster selection timed out"))
        }, timeoutMs)
      }),
    ])
    const valid = isRecord(result) &&
      ["selected", "no-plan", "no-eligible"].includes(String(result.status)) &&
      result.apiVersion === QUARTERMASTER_API_VERSION && typeof result.reasonCode === "string" &&
      typeof result.reason === "string" && Array.isArray(result.skipped) &&
      (result.status !== "selected" || (
        isRecord(result.selected) &&
        typeof result.selected.providerID === "string" && result.selected.providerID.trim().length > 0 &&
        typeof result.selected.modelID === "string" && result.selected.modelID.trim().length > 0 &&
        (result.selected.variant === undefined || typeof result.selected.variant === "string")
      ))
    return valid
      ? result as SafeSelectionResult
      : { status: "unavailable", reasonCode: "invalid-response", reason: "Quartermaster returned an invalid response." }
  } catch {
    return {
      status: "unavailable",
      reasonCode: timedOut ? "timeout" : "service-unavailable",
      reason: timedOut ? "Quartermaster selection timed out." : "Quartermaster service is unavailable.",
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}


export type SafePlanSelectionResult =
  | ({
      status: "selected"
      selected: { providerID: string; modelID: string; variant?: string }
      plan: { id: string; source: "named-plan"; reasonCode: string }
    } & SelectionMetadata)
  | ({
      status: "no-eligible"
      plan: { id: string; source: "named-plan"; reasonCode: string }
    } & SelectionMetadata)
  | ({ status: "no-plan" } & SelectionMetadata)
  | {
      status: "unavailable"
      reasonCode: "invalid-input" | "timeout" | "service-unavailable" | "invalid-response"
      reason: string
    }

function validSkip(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.model) || typeof value.code !== "string" || typeof value.reason !== "string") return false
  return nonempty(value.model.providerID) && nonempty(value.model.modelID) &&
    (value.model.variant === undefined || nonempty(value.model.variant))
}

function validPlanSelection(value: unknown, planID: string): boolean {
  if (!isRecord(value) || value.apiVersion !== QUARTERMASTER_API_VERSION || typeof value.reasonCode !== "string" ||
    typeof value.reason !== "string" || !Array.isArray(value.skipped) || !value.skipped.every(validSkip)) return false
  if (value.status === "no-plan") return value.selected === undefined && value.plan === undefined
  if (!isRecord(value.plan) || value.plan.id !== planID || value.plan.source !== "named-plan" || typeof value.plan.reasonCode !== "string") return false
  if (value.status === "no-eligible") return value.selected === undefined
  return value.status === "selected" && isRecord(value.selected) && nonempty(value.selected.providerID) &&
    nonempty(value.selected.modelID) && (value.selected.variant === undefined || nonempty(value.selected.variant))
}

export async function requestPlanSelection(
  ctx: Pick<Context, "rpc">,
  input: { plan: string },
  timeoutMs = 2_000,
): Promise<SafePlanSelectionResult> {
  if (!isRecord(input) || Object.keys(input).length !== 1 || !nonempty(input.plan) || input.plan.length > 256) {
    return { status: "unavailable", reasonCode: "invalid-input", reason: "Expected a plan name." }
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return { status: "unavailable", reasonCode: "invalid-input", reason: "Expected a request timeout." }
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    const result = await Promise.race([
      ctx.rpc(QUARTERMASTER_RPC).selectPlan(input, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          controller.abort()
          reject(new Error("Quartermaster plan selection timed out"))
        }, timeoutMs)
      }),
    ])
    return validPlanSelection(result, input.plan)
      ? result as SafePlanSelectionResult
      : { status: "unavailable", reasonCode: "invalid-response", reason: "Quartermaster returned an invalid response." }
  } catch {
    return {
      status: "unavailable",
      reasonCode: timedOut ? "timeout" : "service-unavailable",
      reason: timedOut ? "Quartermaster plan selection timed out." : "Quartermaster service is unavailable.",
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export type ReportRequest = Omit<Partial<ReportQuery>, "limit" | "offset"> & {
  projectID?: string
  limit?: number
  offset?: number
  refresh?: boolean
}
export type SafeReportResult = QuartermasterReport | {
  apiVersion: 1
  status: "unsupported" | "unavailable"
  reasonCode: string
  reason: string
}

export async function requestReport(
  ctx: Pick<Context, "rpc">,
  input: ReportRequest = {},
  timeoutMs = 2_000,
): Promise<SafeReportResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    const result = await Promise.race([
      ctx.rpc(QUARTERMASTER_RPC).report(input, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          controller.abort()
          reject(new Error("Quartermaster report timed out"))
        }, timeoutMs)
      }),
    ])
    if (isRecord(result) && result.apiVersion === QUARTERMASTER_API_VERSION && result.status === "unsupported" &&
      typeof result.reasonCode === "string" && typeof result.reason === "string") return result as SafeReportResult
    if (isRecord(result) && result.apiVersion === QUARTERMASTER_API_VERSION && result.status === "ok" &&
      typeof result.projectID === "string" && isRecord(result.totals) && result.totals.complete === false &&
      isRecord(result.dimensions) && Array.isArray(result.dimensions.items) && Array.isArray(result.budgets) &&
       isRecord(result.pluginAttribution) && result.pluginAttribution.attribution === "self-reported-unverified" && result.pluginAttribution.verified === false &&
        isRecord(result.agentAttribution) && result.agentAttribution.evidence === "exact-assistant-message" && result.agentAttribution.complete === false &&
        isRecord(result.planAttribution) && result.planAttribution.status === "model-match-unique" && result.planAttribution.complete === false &&
        isRecord(result.costs) && result.costs.status === "estimated-not-billed" && result.costs.complete === false &&
        isRecord(result.errors) && result.errors.complete === false && result.errors.unattributedExcluded === true &&
      isRecord(result.freshness) && result.freshness.complete === false) return result as unknown as QuartermasterReport
    return { apiVersion: 1, status: "unavailable", reasonCode: "invalid-response", reason: "Quartermaster returned an invalid report." }
  } catch {
    return {
      apiVersion: 1,
      status: "unavailable",
      reasonCode: timedOut ? "timeout" : "service-unavailable",
      reason: timedOut ? "Quartermaster report timed out." : "Quartermaster reporting service is unavailable.",
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function planStatus(config: QuartermasterConfig) {
  return { plans: config.plans, agents: config.agents, workTypes: config.workTypes }
}

function statusFallback(config: QuartermasterConfig, usage?: UsageReadResult) {
  const plans = planStatus(config)
  if (!usage) return { apiVersion: 1, ...plans, status: Object.keys(config.usageSources).length ? "unavailable" : "unconfigured", sources: {} }
  if (usage.status === "unavailable") return { apiVersion: 1, ...plans, status: "unavailable", reason: usage.reason, sources: {} }
  return {
    apiVersion: 1,
    ...plans,
    status: "ok",
    updatedAt: usage.snapshot.updatedAt,
    sources: Object.fromEntries(Object.entries(config.usageSources).map(([provider, sourceID]) => {
      const source = usage.snapshot.sources[sourceID as UsageSourceID]
      return [provider, { sourceID, authenticated: source.authenticated, checkedAt: source.checkedAt,
        stale: source.stale, availability: source.availability, nextAvailableAt: source.nextAvailableAt,
        windows: source.windows.map(({ name, usedPercent, state, resetsAt, resetEstimated }) => ({
          name, usedPercent, state, resetsAt, ...(resetEstimated === undefined ? {} : { resetEstimated }),
        })) }]
    })),
  }
}

export async function registerQuartermasterRpc(
  ctx: Pick<Context, "rpc" | "model">,
  config: QuartermasterConfig,
  routing: AgentRouting | undefined,
  usage?: UsageReadResult,
  reporting?: ReportingServices,
  optionsDirectory?: string,
  readConfiguration: ConfigurationReader = readNativeConfiguration,
  modules?: ModuleCooldowns,
) {
  return ctx.rpc.register(QUARTERMASTER_RPC, {
    async selectModule(input, call) {
      if (!moduleInput(input, false)) throw call.error("invalid_input", "Invalid module selection.", { path: "module", message: "expected only a non-empty module" })
      call.signal.throwIfAborted()
      if (!modules) throw call.error("unavailable", "Module runtime unavailable.", { reason: "not-configured" })
      let result: ModuleSelection
      try {
        result = await modules.query(input.module)
      } catch (error) {
        if (error instanceof ModuleConfigurationUnavailable) {
          throw call.error("unavailable", "Module configuration unavailable.", { reason: error.reason })
        }
        throw error
      }
      call.signal.throwIfAborted()
      return { apiVersion: 1, ...result }
    },
    async reportModuleCooldown(input, call) {
      if (!moduleInput(input, true)) throw call.error("invalid_input", "Invalid module cooldown report.", { path: "report", message: "expected exact module/model scope and supported reason" })
      call.signal.throwIfAborted()
      if (!modules) throw call.error("unavailable", "Module runtime unavailable.", { reason: "not-configured" })
      const result = await modules.report(input)
      call.signal.throwIfAborted()
      return { apiVersion: 1, ...result }
    },
    async selectPlan(input, call) {
      if (!isRecord(input) || Object.keys(input).some((key) => key !== "plan") || !nonempty(input.plan) || input.plan.length > 256) {
        throw call.error("invalid_input", "plan is required", { path: "plan", message: "expected only a non-empty plan name" })
      }
      call.signal.throwIfAborted()
      if (!routing) return { apiVersion: QUARTERMASTER_API_VERSION, status: "no-plan", reasonCode: "unknown-plan", reason: "No model plan is configured with this name.", skipped: [] }
      const result = await routing.selectPlan(input.plan)
      call.signal.throwIfAborted()
      return { apiVersion: QUARTERMASTER_API_VERSION, ...result }
    },
    async select(input, call) {
      if (!isRecord(input) || typeof input.agent !== "string" || !input.agent.trim()) throw call.error("invalid_input", "agent is required", { path: "agent", message: "expected a non-empty string" })
      const agent = input.agent
      if (input.workType !== undefined && (typeof input.workType !== "string" || !input.workType.trim())) throw call.error("invalid_input", "workType is invalid", { path: "workType", message: "expected a non-empty string" })
      if (input.sessionID !== undefined && (typeof input.sessionID !== "string" || !input.sessionID.trim())) throw call.error("invalid_input", "sessionID is invalid", { path: "sessionID", message: "expected a non-empty string" })
      if (routing) return { apiVersion: QUARTERMASTER_API_VERSION, ...await routing.select(agent, input.workType as string | undefined, input.sessionID as string | undefined) }
      return { apiVersion: QUARTERMASTER_API_VERSION, status: "no-plan", reasonCode: "unbound-agent", reason: "No model plan is configured for this agent.", skipped: [] }
    },
    async explain(input, call) {
      if (!isRecord(input) || typeof input.agent !== "string" || !input.agent.trim()) throw call.error("invalid_input", "agent is required", { path: "agent", message: "expected a non-empty string" })
      if (input.sessionID !== undefined && (typeof input.sessionID !== "string" || !input.sessionID.trim())) throw call.error("invalid_input", "sessionID is invalid", { path: "sessionID", message: "expected a non-empty string" })
      return { apiVersion: 1, ...(routing ? await routing.explain(input.agent, typeof input.sessionID === "string" ? input.sessionID : undefined) : { status: "no-plan", reasonCode: "unbound-agent", reason: "No model plan is configured for this agent.", skipped: [] }) }
    },
    async status() {
      await modules?.refresh()
      const status = routing ? await routing.status() : statusFallback(config, usage)
      return modules && Object.keys(config.modules ?? {}).length ? {
        ...status,
        modules: await modules.selections(),
      } : status
    },
    async diagnoseSession(input, call) {
      if (!isRecord(input) || Object.keys(input).some((key) => key !== "sessionID") ||
        typeof input.sessionID !== "string" || !input.sessionID.trim() || input.sessionID.length > 256) {
        throw call.error("invalid_input", "Invalid diagnostic request.", { path: "sessionID", message: "expected a non-empty session ID up to 256 characters" })
      }
      if (!routing) throw call.error("unavailable", "Session diagnostics are unavailable.", { reason: "routing-unavailable" })
      return routing.diagnoseSession(input.sessionID)
    },
    async report(input, call) {
      if (!isRecord(input)) throw call.error("invalid_input", "Invalid report request.", { path: "request", message: "expected an object" })
      for (const key of Object.keys(input)) {
        if (!["projectID", "since", "until", "limit", "offset", "refresh"].includes(key)) {
          throw call.error("invalid_input", "Unknown report field.", { path: key, message: "unknown field" })
        }
      }
      if (input.projectID !== undefined && (typeof input.projectID !== "string" || !input.projectID.trim())) {
        throw call.error("invalid_input", "Invalid projectID.", { path: "projectID", message: "expected a non-empty project ID" })
      }
      for (const field of ["since", "until"] as const) {
        if (input[field] !== undefined && (typeof input[field] !== "number" || !Number.isSafeInteger(input[field]))) {
          throw call.error("invalid_input", `Invalid ${field}.`, { path: field, message: "expected a safe integer timestamp" })
        }
      }
      if (typeof input.since === "number" && typeof input.until === "number" && input.since > input.until) {
        throw call.error("invalid_input", "Invalid time range.", { path: "since", message: "since must not be after until" })
      }
      const limit = input.limit === undefined ? 50 : input.limit
      const offset = input.offset === undefined ? 0 : input.offset
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > REPORT_MAX_PAGE_SIZE) {
        throw call.error("invalid_input", "Invalid page size.", { path: "limit", message: `expected an integer from 1 to ${REPORT_MAX_PAGE_SIZE}` })
      }
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > REPORT_MAX_OFFSET) {
        throw call.error("invalid_input", "Invalid page offset.", { path: "offset", message: `expected an integer from 0 to ${REPORT_MAX_OFFSET}` })
      }
      if (input.refresh !== undefined && typeof input.refresh !== "boolean") {
        throw call.error("invalid_input", "Invalid refresh flag.", { path: "refresh", message: "expected a boolean" })
      }
      if (!reporting) return {
        apiVersion: QUARTERMASTER_API_VERSION,
        status: "unsupported",
        reasonCode: "telemetry-unavailable",
        reason: "Quartermaster reporting is not configured.",
      }
      if (input.projectID !== undefined && input.projectID !== reporting.projectID) return {
        apiVersion: QUARTERMASTER_API_VERSION,
        status: "unsupported",
        reasonCode: "cross-project-authorization-unavailable",
        reason: "Reports are limited to the active project; cross-project authorization is not available.",
      }
      const query: ReportQuery = {
        ...(input.since === undefined ? {} : { since: input.since as number }),
        ...(input.until === undefined ? {} : { until: input.until as number }),
        limit,
        offset,
      }
      return buildQuartermasterReport({
        ...reporting,
        plans: reporting.plans ?? config.plans,
        catalog: reporting.catalog ?? (() => readCatalogSnapshot(() => ctx.model.list())),
      }, query, input.refresh === true)
    },
    async readOptions(_input, call) {
      if (!optionsDirectory) throw call.error("unavailable", "Project options are unavailable.", { reason: "no-project" })
      try {
        const loaded = await readProjectQuartermasterOptions(optionsDirectory, readConfiguration)
        return { apiVersion: QUARTERMASTER_API_VERSION, status: "ok", options: loaded.options, revision: loaded.revision, writable: loaded.writable }
      } catch {
        throw call.error("unavailable", "Quartermaster project options could not be read.", { reason: "read-failed" })
      }
    },
    async applyOptions(input, call) {
      if (!optionsDirectory) throw call.error("unavailable", "Project options are unavailable.", { reason: "no-project" })
      if (!isRecord(input) || Object.keys(input).some((key) => !["options", "revision"].includes(key)) ||
        !isRecord(input.options) || typeof input.revision !== "number" || !Number.isFinite(input.revision) || input.revision < 0) {
        throw call.error("invalid_input", "Invalid project options update.", { path: "request", message: "expected options and revision" })
      }
      try {
        await applyProjectQuartermasterOptions({ directory: optionsDirectory, options: input.options, revision: input.revision, signal: call.signal, readConfiguration })
        const loaded = await readProjectQuartermasterOptions(optionsDirectory, readConfiguration)
        return { apiVersion: QUARTERMASTER_API_VERSION, status: "saved", options: loaded.options, revision: loaded.revision }
      } catch (error) {
        if (error instanceof Error && error.message === "Project config changed; refusing to overwrite") {
          throw call.error("unavailable", "Project config changed. Reload before saving.", { reason: "stale-revision" })
        }
        throw call.error("invalid_input", "Quartermaster options were not saved. Check the values and project config.", { path: "options", message: "invalid or unavailable project options" })
      }
    },
    async reportPluginUsage(input, call) {
      if (!isRecord(input) || Object.keys(input).some((key) => !["pluginID", "pluginName", "sessionIDs"].includes(key))) {
        throw call.error("invalid_input", "Invalid plugin usage claim.", { path: "request", message: "expected pluginID, pluginName, and sessionIDs only" })
      }
      if (typeof input.pluginID !== "string" || !input.pluginID.trim() || input.pluginID.length > 128) {
        throw call.error("invalid_input", "Invalid pluginID.", { path: "pluginID", message: "expected a non-empty ID up to 128 characters" })
      }
      if (typeof input.pluginName !== "string" || !input.pluginName.trim() || input.pluginName.length > 128) {
        throw call.error("invalid_input", "Invalid pluginName.", { path: "pluginName", message: "expected a non-empty name up to 128 characters" })
      }
      if (!Array.isArray(input.sessionIDs) || input.sessionIDs.length < 1 || input.sessionIDs.length > MAX_ATTRIBUTION_SESSIONS ||
        input.sessionIDs.some((sessionID) => typeof sessionID !== "string" || !sessionID.trim() || sessionID.length > 256)) {
        throw call.error("invalid_input", "Invalid sessionIDs.", { path: "sessionIDs", message: "expected 1 to 100 non-empty host session IDs up to 256 characters" })
      }
      if (!reporting) return {
        apiVersion: QUARTERMASTER_API_VERSION,
        status: "unsupported",
        reasonCode: "telemetry-unavailable",
        reason: "Quartermaster attribution reporting is not configured.",
      }
      const sessionIDs = [...new Set(input.sessionIDs as string[])]
      await reporting.attributionLedger.claim(reporting.projectID, input.pluginID.trim(), input.pluginName.trim(), sessionIDs)
      return {
        apiVersion: QUARTERMASTER_API_VERSION,
        status: "accepted",
        attribution: "self-reported-unverified",
        acceptedSessions: sessionIDs.length,
      }
    },
    async reportDirectUsage(input, call) {
      const fields = ["pluginID", "pluginName", "usageID", "providerID", "modelID", "variant", "counts"]
      if (!isRecord(input) || Object.keys(input).some((key) => !fields.includes(key))) {
        throw call.error("invalid_input", "Invalid direct usage report.", { path: "request", message: "unexpected field" })
      }
      const text = (value: unknown, max: number, path: string) => {
        if (typeof value !== "string" || value.length < 1 || value.length > max || value !== value.trim()) {
          throw call.error("invalid_input", `Invalid ${path}.`, { path, message: `expected a non-empty string up to ${max} characters` })
        }
        return value
      }
      const pluginID = text(input.pluginID, 128, "pluginID")
      const pluginName = text(input.pluginName, 128, "pluginName")
      const usageID = text(input.usageID, 128, "usageID")
      const providerID = text(input.providerID, 256, "providerID")
      const modelID = text(input.modelID, 256, "modelID")
      const variant = input.variant === undefined ? null : text(input.variant, 128, "variant")
      const countFields = ["input", "output", "reasoning", "cacheRead", "cacheWrite"]
      if (!isRecord(input.counts) || Object.keys(input.counts).some((key) => !countFields.includes(key))) {
        throw call.error("invalid_input", "Invalid counts.", { path: "counts", message: "expected input, output, and optional reasoning or cache counts" })
      }
      const count = (value: unknown, path: string, required: boolean) => {
        if (value === undefined && !required) return undefined
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
          throw call.error("invalid_input", `Invalid ${path}.`, { path, message: "expected a non-negative integer" })
        }
        return value
      }
      const counts = {
        input: count(input.counts.input, "counts.input", true)!,
        output: count(input.counts.output, "counts.output", true)!,
        reasoning: count(input.counts.reasoning, "counts.reasoning", false),
        cacheRead: count(input.counts.cacheRead, "counts.cacheRead", false),
        cacheWrite: count(input.counts.cacheWrite, "counts.cacheWrite", false),
      }
      if (!reporting?.directUsageLedger) return {
        apiVersion: QUARTERMASTER_API_VERSION,
        status: "unsupported",
        reasonCode: "telemetry-unavailable",
        reason: "Quartermaster direct usage reporting is not configured.",
      }
      const recorded = await reporting.directUsageLedger.record({
        projectID: reporting.projectID,
        pluginID, pluginName, usageID, providerID, modelID, variant, counts,
      })
      return {
        apiVersion: QUARTERMASTER_API_VERSION,
        status: "accepted",
        attribution: "self-reported-unverified",
        replaced: recorded.replaced,
      }
    },
    async pin(input, call) {
      if (!routing) throw call.error("unavailable", "No routing plan is configured.", { reason: "not-configured" })
      if (!isRecord(input) || typeof input.agent !== "string" || !input.agent.trim()) throw call.error("invalid_input", "Invalid pin request", { path: "agent", message: "expected a non-empty string" })
      const agent = input.agent
      const modelInput = input.model
      if (!isRecord(modelInput)) throw call.error("invalid_input", "Invalid pin request", { path: "model", message: "expected a model reference" })
      try {
        const enabled = (await ctx.model.list()).data.filter((entry) => entry.enabled)
        if (!enabled.some((entry) => entry.providerID === modelInput.providerID && entry.id === modelInput.modelID)) throw new Error()
        await routing.refresh()
        return { apiVersion: 1, status: "pinned", model: await routing.pin(agent, modelInput) }
      } catch {
        throw call.error("invalid_input", "Pin must reference an enabled plan candidate.", { path: "model", message: "invalid pin" })
      }
    },
    async unpin(input, call) {
      if (!routing) throw call.error("unavailable", "No routing plan is configured.", { reason: "not-configured" })
      if (!isRecord(input) || typeof input.agent !== "string" || !input.agent.trim()) throw call.error("invalid_input", "agent is required", { path: "agent", message: "expected a non-empty string" })
      try {
        return { apiVersion: 1, status: await routing.unpin(input.agent) ? "unpinned" : "not-pinned" }
      } catch {
        throw call.error("invalid_input", "Agent has no configured plan.", { path: "agent", message: "unbound agent" })
      }
    },
    async reportFailure(input, call) {
      const classifications = ["provider-outage", "model-outage", "temporary-rate-limit", "quota-exhausted", "auth", "cancelled", "other"]
      if (!isRecord(input) || typeof input.providerID !== "string" || !input.providerID.trim() || typeof input.classification !== "string" || !classifications.includes(input.classification)) {
        throw call.error("invalid_input", "Invalid failure report.", { path: "report", message: "expected providerID and a known classification" })
      }
      if (input.modelID !== undefined && (typeof input.modelID !== "string" || !input.modelID.trim())) throw call.error("invalid_input", "Invalid modelID.", { path: "modelID", message: "expected a non-empty string" })
      if (input.classification === "model-outage" && input.modelID === undefined) throw call.error("invalid_input", "modelID is required.", { path: "modelID", message: "required for model-outage" })
      if (!routing) throw call.error("unavailable", "No routing plan is configured.", { reason: "not-configured" })
      const report = input as unknown as FailureReport
      const enabled = (await ctx.model.list()).data.filter((entry) => entry.enabled)
      if (!enabled.some((entry) => entry.providerID === report.providerID && (!report.modelID || entry.id === report.modelID))) throw call.error("invalid_input", "Failure report is outside the enabled registry.", { path: "providerID", message: "unknown provider/model" })
      return { apiVersion: 1, accepted: await routing.reportFailure(report) }
    },
    async reportSuccess(input, call) {
      if (!isRecord(input) || typeof input.providerID !== "string" || !input.providerID.trim() || (input.scope !== "provider" && input.scope !== "model")) {
        throw call.error("invalid_input", "Invalid success report.", { path: "report", message: "expected providerID and scope" })
      }
      if (input.modelID !== undefined && (typeof input.modelID !== "string" || !input.modelID.trim())) throw call.error("invalid_input", "Invalid modelID.", { path: "modelID", message: "expected a non-empty string" })
      if (input.scope === "model" && input.modelID === undefined) throw call.error("invalid_input", "modelID is required.", { path: "modelID", message: "required for model scope" })
      if (!routing) throw call.error("unavailable", "No routing plan is configured.", { reason: "not-configured" })
      const report = input as unknown as SuccessReport
      const enabled = (await ctx.model.list()).data.filter((entry) => entry.enabled)
      if (!enabled.some((entry) => entry.providerID === report.providerID && (report.scope === "provider" || entry.id === report.modelID))) throw call.error("invalid_input", "Success report is outside the enabled registry.", { path: "providerID", message: "unknown provider/model" })
      return { apiVersion: 1, accepted: await routing.reportSuccess(report) }
    },
  })
}
