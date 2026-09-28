export interface ModelRef {
  providerID: string
  modelID: string
  variant?: string
}

export interface QuartermasterConfig {
  plans: Record<string, ModelRef[]>
  agents: Record<string, string>
  workTypes: Record<string, string>
  usageSources: Record<string, string>
  quotaExemptModels: string[]
  providerCooldownMs: number
  localHealthTimeoutMs: number
  localEndpoints: Record<string, string>
}

const DEFAULTS = { providerCooldownMs: 300_000, localHealthTimeoutMs: 2_000 }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path}: expected an object`)
  return value
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`${path}: expected a non-empty string without surrounding whitespace`)
  }
  return value
}

function modelRef(value: unknown, path: string): ModelRef {
  const item = isRecord(value) ? value : { id: value }
  for (const key of Object.keys(item)) {
    if (key !== "id" && key !== "variant") throw new Error(`${path}.${key}: unknown field`)
  }
  const id = string(item.id, `${path}.id`)
  const split = id.indexOf("/")
  if (split <= 0 || split === id.length - 1 || /\s/.test(id)) {
    throw new Error(`${path}.id: expected providerID/modelID`)
  }
  const ref = { providerID: id.slice(0, split), modelID: id.slice(split + 1) }
  return item.variant === undefined ? ref : { ...ref, variant: string(item.variant, `${path}.variant`) }
}

function plansFrom(value: unknown): Record<string, ModelRef[]> {
  return Object.fromEntries(Object.entries(record(value, "plans")).map(([id, candidates]) => {
    const path = `plans.${id}`
    string(id, path)
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error(`${path}: expected a non-empty array of model candidates`)
    }
    const seen = new Set<string>()
    return [id, candidates.map((value, index) => {
      const ref = modelRef(value, `${path}[${index}]`)
      const key = JSON.stringify([ref.providerID, ref.modelID, ref.variant ?? null])
      if (seen.has(key)) throw new Error(`${path}[${index}]: duplicate model candidate`)
      seen.add(key)
      return ref
    })]
  }))
}

function stringMap(value: unknown, path: string): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value, path)).map(([key, item]) => [
    string(key, `${path}.${key}`), string(item, `${path}.${key}`),
  ]))
}

function quotaExemptModels(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("quotaExemptModels: expected an array of providerID/modelID strings")
  const seen = new Set<string>()
  return value.map((value, index) => {
    const path = `quotaExemptModels[${index}]`
    const id = string(value, path)
    const split = id.indexOf("/")
    if (split <= 0 || split === id.length - 1 || /\s/.test(id)) {
      throw new Error(`${path}: expected providerID/modelID`)
    }
    const key = JSON.stringify([id.slice(0, split), id.slice(split + 1)])
    if (seen.has(key)) throw new Error(`${path}: duplicate model exemption`)
    seen.add(key)
    return id
  })
}

function duration(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path}: expected a positive safe integer number of milliseconds`)
  }
  return value
}

function localEndpoints(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value, "localEndpoints")).map(([provider, value]) => {
    const path = `localEndpoints.${provider}`
    let url: URL
    try {
      url = new URL(string(value, path))
    } catch {
      throw new Error(`${path}: expected a loopback HTTP(S) URL`)
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash
    ) throw new Error(`${path}: expected a loopback HTTP(S) URL without credentials or query`)
    return [string(provider, path), url.toString()]
  }))
}

export function parseConfig(input: unknown = {}): QuartermasterConfig {
  const options = record(input, "options")
  const fields = new Set([
    "plans", "agents", "workTypes", "usageSources", "quotaExemptModels", "providerCooldownMs",
    "localHealthTimeoutMs", "localEndpoints",
  ])
  for (const key of Object.keys(options)) {
    if (!fields.has(key)) throw new Error(`options.${key}: unknown field`)
  }

  const plans = options.plans === undefined ? {} : plansFrom(options.plans)
  const agents = options.agents === undefined ? {} : stringMap(options.agents, "agents")
  const workTypes = options.workTypes === undefined ? {} : stringMap(options.workTypes, "workTypes")
  const usageSources = options.usageSources === undefined ? {} : stringMap(options.usageSources, "usageSources")
  for (const [provider, source] of Object.entries(usageSources)) {
    if (!["go", "codex", "cursor"].includes(source)) {
      throw new Error(`usageSources.${provider}: expected one of go, codex, cursor`)
    }
  }
  const exemptModels = options.quotaExemptModels === undefined ? [] : quotaExemptModels(options.quotaExemptModels)
  const local = options.localEndpoints === undefined ? {} : localEndpoints(options.localEndpoints)

  for (const [agent, plan] of Object.entries(agents)) {
    if (!Object.hasOwn(plans, plan)) throw new Error(`agents.${agent}: unknown plan "${plan}"`)
  }
  for (const [workType, plan] of Object.entries(workTypes)) {
    if (!Object.hasOwn(plans, plan)) throw new Error(`workTypes.${workType}: unknown plan "${plan}"`)
  }

  return {
    plans,
    agents,
    workTypes,
    usageSources,
    quotaExemptModels: exemptModels,
    providerCooldownMs: duration(options.providerCooldownMs, "providerCooldownMs", DEFAULTS.providerCooldownMs),
    localHealthTimeoutMs: duration(options.localHealthTimeoutMs, "localHealthTimeoutMs", DEFAULTS.localHealthTimeoutMs),
    localEndpoints: local,
  }
}
