import { Rpc } from "@opencode/plugin/rpc"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { QuartermasterConfig } from "./config.ts"
import type { FailureReport, SuccessReport } from "./failures.ts"
import type { registerAgentRouting } from "./agent-routing.ts"
import type { UsageReadResult, UsageSourceID } from "./usage.ts"

type AgentRouting = NonNullable<Awaited<ReturnType<typeof registerAgentRouting>>>

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
    select: { input: object({ agent: string, workType: string }, ["agent"]), output, errors: { invalid_input: errors.invalid_input } },
    explain: { input: object({ agent: string }, ["agent"]), output, errors: { invalid_input: errors.invalid_input } },
    status: { input: object({}), output },
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

export type SafeSelectionResult =
  | { status: "unavailable"; reasonCode: "service-unavailable" | "timeout" | "invalid-response"; reason: string }
  | {
      status: "selected" | "no-plan" | "no-eligible"
      apiVersion: number
      reasonCode: string
      reason: string
      selected?: { providerID: string; modelID: string; variant?: string }
      skipped: unknown[]
      [key: string]: unknown
    }

export async function requestSelection(
  ctx: Pick<Context, "rpc">,
  input: { agent: string; workType?: string },
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
      typeof result.apiVersion === "number" && typeof result.reasonCode === "string" &&
      typeof result.reason === "string" && Array.isArray(result.skipped) &&
      (result.status !== "selected" || (isRecord(result.selected) && typeof result.selected.providerID === "string" && typeof result.selected.modelID === "string"))
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

function statusFallback(config: QuartermasterConfig, usage?: UsageReadResult) {
  if (!usage) return { apiVersion: 1, status: Object.keys(config.usageSources).length ? "unavailable" : "unconfigured", sources: {} }
  if (usage.status === "unavailable") return { apiVersion: 1, status: "unavailable", reason: usage.reason, sources: {} }
  return {
    apiVersion: 1,
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
) {
  return ctx.rpc.register(QUARTERMASTER_RPC, {
    async select(input, call) {
      if (!isRecord(input) || typeof input.agent !== "string" || !input.agent.trim()) throw call.error("invalid_input", "agent is required", { path: "agent", message: "expected a non-empty string" })
      const agent = input.agent
      if (input.workType !== undefined && (typeof input.workType !== "string" || !input.workType.trim())) throw call.error("invalid_input", "workType is invalid", { path: "workType", message: "expected a non-empty string" })
      if (routing) return { apiVersion: 1, ...await routing.select(agent, input.workType as string | undefined) }
      return { apiVersion: 1, status: "no-plan", reasonCode: "unbound-agent", reason: "No model plan is configured for this agent.", skipped: [] }
    },
    async explain(input, call) {
      if (!isRecord(input) || typeof input.agent !== "string" || !input.agent.trim()) throw call.error("invalid_input", "agent is required", { path: "agent", message: "expected a non-empty string" })
      return { apiVersion: 1, ...(routing ? routing.explain(input.agent) : { status: "no-plan", reasonCode: "unbound-agent", reason: "No model plan is configured for this agent.", skipped: [] }) }
    },
    async status() {
      return routing ? routing.status() : statusFallback(config, usage)
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
