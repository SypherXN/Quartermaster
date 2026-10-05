export interface ModelRef {
  providerID: string
  modelID: string
  variant?: string
}

export type TokenBudgetDimension = "project" | "provider" | "model" | "plugin"

export interface TokenBudgetCalendarWindow {
  unit: "day" | "week" | "month"
  timeZone: string
}

export interface TokenBudgetConfig {
  id: string
  dimension: TokenBudgetDimension
  mode?: "advisory" | "strict"
  target?: string
  limitTokens: number
  windowMs?: number
  calendarWindow?: TokenBudgetCalendarWindow
}

export interface TokenRateConfig {
  providerID: string
  modelID: string
  variant?: string
  inputPerMillion: number
  outputPerMillion: number
  currency: string
  source: string
  asOf: number
}

export interface QuartermasterConfig {
  plans: Record<string, ModelRef[]>
  agents: Record<string, string>
  workTypes: Record<string, string>
  usageSources: Record<string, string>
  budgets?: TokenBudgetConfig[]
  tokenRates?: TokenRateConfig[]
  quotaExemptModels: string[]
  exclusiveModels: ModelRef[]
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

function exclusiveModels(value: unknown): ModelRef[] {
  if (!Array.isArray(value)) throw new Error("exclusiveModels: expected an array of providerID/modelID strings")
  const seen = new Set<string>()
  return value.map((item, index) => {
    const path = `exclusiveModels[${index}]`
    const id = string(item, path)
    const split = id.indexOf("/")
    if (split <= 0 || split === id.length - 1 || /\s/.test(id)) throw new Error(`${path}: expected providerID/modelID`)
    const ref = { providerID: id.slice(0, split), modelID: id.slice(split + 1) }
    const key = JSON.stringify([ref.providerID, ref.modelID])
    if (seen.has(key)) throw new Error(`${path}: duplicate exclusive model`)
    seen.add(key)
    return ref
  })
}

function duration(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path}: expected a positive safe integer number of milliseconds`)
  }
  return value
}

function budgetsFrom(value: unknown): TokenBudgetConfig[] {
  if (!Array.isArray(value)) throw new Error("budgets: expected an array")
  const seen = new Set<string>()
  return value.map((item, index) => {
    const path = `budgets[${index}]`
    const budget = record(item, path)
    for (const key of Object.keys(budget)) {
      if (!["id", "dimension", "mode", "target", "limitTokens", "windowMs", "calendarWindow"].includes(key)) {
        throw new Error(`${path}.${key}: unknown field`)
      }
    }
    const id = string(budget.id, `${path}.id`)
    if (seen.has(id)) throw new Error(`${path}.id: duplicate budget ID`)
    seen.add(id)
    const dimension = budget.dimension
    if (!["project", "provider", "model", "plugin"].includes(String(dimension))) {
      throw new Error(`${path}.dimension: expected project, provider, model, or plugin`)
    }
    const mode = budget.mode === undefined ? "advisory" : budget.mode
    if (mode !== "advisory" && mode !== "strict") {
      throw new Error(`${path}.mode: expected advisory or strict`)
    }
    const target = budget.target === undefined ? undefined : string(budget.target, `${path}.target`)
    if (dimension === "project" && target !== undefined) {
      throw new Error(`${path}.target: project budgets do not accept a target`)
    }
    if (dimension !== "project" && target === undefined) {
      throw new Error(`${path}.target: required for ${String(dimension)} budgets`)
    }
    if (dimension === "model") {
      const split = target!.indexOf("/")
      if (split <= 0 || split === target!.length - 1 || /\s/.test(target!)) {
        throw new Error(`${path}.target: expected providerID/modelID`)
      }
    }
    const positiveInteger = (key: "limitTokens" | "windowMs") => {
      const number = budget[key]
      if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
        throw new Error(`${path}.${key}: expected a positive safe integer`)
      }
      return number
    }
    if ((budget.windowMs === undefined) === (budget.calendarWindow === undefined)) {
      throw new Error(`${path}: specify exactly one of windowMs or calendarWindow`)
    }
    let calendarWindow: TokenBudgetCalendarWindow | undefined
    if (budget.calendarWindow !== undefined) {
      const calendar = record(budget.calendarWindow, `${path}.calendarWindow`)
      for (const key of Object.keys(calendar)) {
        if (key !== "unit" && key !== "timeZone") {
          throw new Error(`${path}.calendarWindow.${key}: unknown field`)
        }
      }
      const unit = calendar.unit
      if (unit !== "day" && unit !== "week" && unit !== "month") {
        throw new Error(`${path}.calendarWindow.unit: expected day, week, or month`)
      }
      const timeZone = calendar.timeZone === undefined
        ? "UTC"
        : string(calendar.timeZone, `${path}.calendarWindow.timeZone`)
      try {
        new Intl.DateTimeFormat("en", { timeZone }).format(0)
      } catch {
        throw new Error(`${path}.calendarWindow.timeZone: expected an IANA timezone`)
      }
      calendarWindow = { unit, timeZone }
    }
    return {
      id,
      dimension: dimension as TokenBudgetDimension,
      mode,
      ...(target === undefined ? {} : { target }),
      limitTokens: positiveInteger("limitTokens"),
      ...(budget.windowMs === undefined ? {} : { windowMs: positiveInteger("windowMs") }),
      ...(calendarWindow === undefined ? {} : { calendarWindow }),
    }
  })
}

function tokenRatesFrom(value: unknown): TokenRateConfig[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("tokenRates: expected an array of at most 100 rates")
  const seen = new Set<string>()
  return value.map((item, index) => {
    const path = `tokenRates[${index}]`
    const rate = record(item, path)
    for (const key of Object.keys(rate)) {
      if (![
        "providerID", "modelID", "variant", "inputPerMillion", "outputPerMillion", "currency", "source", "asOf",
      ].includes(key)) throw new Error(`${path}.${key}: unknown field`)
    }
    const providerID = string(rate.providerID, `${path}.providerID`)
    const modelID = string(rate.modelID, `${path}.modelID`)
    const variant = rate.variant === undefined ? undefined : string(rate.variant, `${path}.variant`)
    const key = JSON.stringify([providerID, modelID, variant ?? null])
    if (seen.has(key)) throw new Error(`${path}: duplicate provider/model/variant rate`)
    seen.add(key)
    const price = (field: "inputPerMillion" | "outputPerMillion") => {
      const value = rate[field]
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${path}.${field}: expected a finite non-negative rate`)
      }
      return value
    }
    const currency = string(rate.currency, `${path}.currency`)
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`${path}.currency: expected a three-letter uppercase currency code`)
    if (typeof rate.asOf !== "number" || !Number.isSafeInteger(rate.asOf) || rate.asOf < 0) {
      throw new Error(`${path}.asOf: expected a non-negative safe integer timestamp`)
    }
    return {
      providerID, modelID,
      ...(variant === undefined ? {} : { variant }),
      inputPerMillion: price("inputPerMillion"),
      outputPerMillion: price("outputPerMillion"),
      currency,
      source: string(rate.source, `${path}.source`),
      asOf: rate.asOf,
    }
  })
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
    "plans", "agents", "workTypes", "usageSources", "quotaExemptModels", "exclusiveModels", "providerCooldownMs",
    "localHealthTimeoutMs", "localEndpoints", "budgets", "tokenRates",
  ])
  for (const key of Object.keys(options)) {
    if (!fields.has(key)) throw new Error(`options.${key}: unknown field`)
  }

  const plans = options.plans === undefined ? {} : plansFrom(options.plans)
  const agents = options.agents === undefined ? {} : stringMap(options.agents, "agents")
  const workTypes = options.workTypes === undefined ? {} : stringMap(options.workTypes, "workTypes")
  const usageSources = options.usageSources === undefined ? {} : stringMap(options.usageSources, "usageSources")
  const budgets = options.budgets === undefined ? undefined : budgetsFrom(options.budgets)
  const tokenRates = options.tokenRates === undefined ? undefined : tokenRatesFrom(options.tokenRates)
  for (const [provider, source] of Object.entries(usageSources)) {
    if (!["go", "codex", "cursor"].includes(source)) {
      throw new Error(`usageSources.${provider}: expected one of go, codex, cursor`)
    }
  }
  const exemptModels = options.quotaExemptModels === undefined ? [] : quotaExemptModels(options.quotaExemptModels)
  const exclusive = options.exclusiveModels === undefined ? [] : exclusiveModels(options.exclusiveModels)
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
    ...(budgets === undefined ? {} : { budgets }),
    ...(tokenRates === undefined ? {} : { tokenRates }),
    quotaExemptModels: exemptModels,
    exclusiveModels: exclusive,
    providerCooldownMs: duration(options.providerCooldownMs, "providerCooldownMs", DEFAULTS.providerCooldownMs),
    localHealthTimeoutMs: duration(options.localHealthTimeoutMs, "localHealthTimeoutMs", DEFAULTS.localHealthTimeoutMs),
    localEndpoints: local,
  }
}
