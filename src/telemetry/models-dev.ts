import type { CatalogPrice } from "./prices.ts"

// Only OpenAI/Anthropic model rows from the fetched API price catalog are used.
// The request carries no headers, query, project or usage data.
export const MODELS_DEV_URL = "https://models.dev/api.json"
const TTL_MS = 6 * 60 * 60_000
const STALE_MS = 7 * 24 * 60 * 60_000
const BACKOFF_MS = 10 * 60_000
const TIMEOUT_MS = 5_000
const MAX_BYTES = 10 * 1024 * 1024

export interface ModelsDevFamilyPrice {
  version: number[]
  prices: readonly CatalogPrice[] | null
  ambiguous: boolean
}

export interface ModelsDevPrices {
  openai: ReadonlyMap<string, readonly CatalogPrice[] | null>
  anthropicByName: ReadonlyMap<string, readonly CatalogPrice[] | null>
  // Canonical stable family -> newest version candidate, even when unpriced.
  families?: ReadonlyMap<string, ModelsDevFamilyPrice>
}

export interface ModelsDevOptions {
  fetch?: typeof fetch
  now?: () => number
  url?: string
}

let cached: { at: number; prices: ModelsDevPrices } | undefined
let backoffUntil = 0
let failureLogged = false
let inFlight: Promise<ModelsDevPrices | undefined> | undefined

export function resetModelsDevCache(): void {
  cached = undefined
  backoffUntil = 0
  failureLogged = false
  inFlight = undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const amount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

function priceRow(value: unknown, tierSize: number | null): CatalogPrice | undefined {
  if (!isRecord(value)) return undefined
  const input = amount(value.input)
  const output = amount(value.output)
  if (input === undefined || output === undefined) return undefined
  const cacheRead = amount(value.cache_read)
  const cacheWrite = amount(value.cache_write)
  if (input === 0 && output === 0 && (cacheRead ?? 0) === 0 && (cacheWrite ?? 0) === 0) return undefined
  return {
    tierSize,
    input,
    output,
    cacheRead: cacheRead ?? 0,
    cacheReadKnown: cacheRead !== undefined,
    cacheWrite: cacheWrite ?? 0,
    cacheWriteKnown: cacheWrite !== undefined,
  }
}

function costRows(value: unknown): CatalogPrice[] | undefined {
  if (!isRecord(value)) return undefined
  const rows: CatalogPrice[] = []
  const base = priceRow(value, null)
  if (base) rows.push(base)
  if (Array.isArray(value.tiers)) {
    for (const tier of value.tiers) {
      if (!isRecord(tier) || !isRecord(tier.tier) || tier.tier.type !== "context") continue
      const size = amount(tier.tier.size)
      if (size === undefined || !Number.isSafeInteger(size) || size <= 0) continue
      const row = priceRow(tier, size)
      if (row) rows.push(row)
    }
  }
  if (!rows.some((row) => row.tierSize !== null) && isRecord(value.context_over_200k)) {
    const row = priceRow(value.context_over_200k, 200_000)
    if (row) rows.push(row)
  }
  return rows.length ? rows : undefined
}

function addUnique(
  table: Map<string, readonly CatalogPrice[] | null>,
  key: string,
  rows: CatalogPrice[] | undefined,
): void {
  if (rows === undefined) return
  table.set(key, table.has(key) ? null : rows)
}

const CLAUDE_FAMILY_NAME = /^Claude (Opus|Sonnet|Haiku|Fable) (\d+(?:\.\d+)*)$/
const NON_STABLE_ID = /(?:^|[-_])(preview|beta|experimental|fast|latest|deprecated)(?:$|[-_])/i
const DATED_ID = /-\d{8}$|-\d{4}-\d{2}-\d{2}$/

function compareVersions(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a - b
  }
  return 0
}

function claudeFamily(name: string, id: string): { family: string; version: number[] } | undefined {
  const match = CLAUDE_FAMILY_NAME.exec(name)
  if (!match || NON_STABLE_ID.test(id) || DATED_ID.test(id)) return undefined
  const version = match[2].split(".").map((part) => Number(part))
  if (!version.every((part) => Number.isSafeInteger(part) && part >= 0)) return undefined
  return { family: match[1], version }
}

function addFamily(
  families: Map<string, ModelsDevFamilyPrice>,
  family: string,
  version: number[],
  rows: CatalogPrice[] | undefined,
): void {
  const existing = families.get(family)
  if (!existing) {
    families.set(family, { version, prices: rows ?? null, ambiguous: false })
    return
  }
  const order = compareVersions(version, existing.version)
  if (order > 0) families.set(family, { version, prices: rows ?? null, ambiguous: false })
  else if (order === 0) families.set(family, { ...existing, ambiguous: true })
}

export function modelsDevPricesFromData(value: unknown): ModelsDevPrices | undefined {
  if (!isRecord(value)) return undefined
  const openai = new Map<string, readonly CatalogPrice[] | null>()
  const anthropicByName = new Map<string, readonly CatalogPrice[] | null>()
  const families = new Map<string, ModelsDevFamilyPrice>()
  const openaiModels = isRecord(value.openai) && isRecord(value.openai.models) ? value.openai.models : undefined
  for (const [key, model] of Object.entries(openaiModels ?? {})) {
    if (!isRecord(model)) continue
    const id = typeof model.id === "string" && model.id.length > 0 ? model.id : key
    addUnique(openai, id, costRows(model.cost))
  }
  const anthropicModels = isRecord(value.anthropic) && isRecord(value.anthropic.models) ? value.anthropic.models : undefined
  for (const [key, model] of Object.entries(anthropicModels ?? {})) {
    if (!isRecord(model)) continue
    const name = typeof model.name === "string" && model.name.length > 0 ? model.name : key
    const rows = costRows(model.cost)
    addUnique(anthropicByName, name, rows)
    const id = typeof model.id === "string" && model.id.length > 0 ? model.id : key
    const family = claudeFamily(name, id)
    if (family) addFamily(families, family.family, family.version, rows)
  }
  return { openai, anthropicByName, families }
}

async function readBounded(response: Response): Promise<string> {
  const length = Number(response.headers?.get("content-length"))
  if (Number.isFinite(length) && length > MAX_BYTES) throw new Error("models.dev response too large")
  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error("models.dev response too large")
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_BYTES) {
      await reader.cancel()
      throw new Error("models.dev response too large")
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function fetchPrices(options: ModelsDevOptions): Promise<ModelsDevPrices> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const response = await fetchImpl(options.url ?? MODELS_DEV_URL, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error("models.dev status")
  const prices = modelsDevPricesFromData(JSON.parse(await readBounded(response)))
  if (!prices) throw new Error("models.dev shape")
  return prices
}

/**
 * Never waits for the network: returns whatever is cached (even past the TTL, within the
 * stale window) and starts a refresh in the background. Used on the routing/startup path.
 */
export function peekModelsDevPrices(options: ModelsDevOptions = {}): ModelsDevPrices | undefined {
  const at = (options.now ?? Date.now)()
  readModelsDevPrices(options).catch(() => undefined)
  return cached && at - cached.at <= STALE_MS ? cached.prices : undefined
}

/** Cached fetched prices: 6h success TTL, 7d stale-on-error, 10m failure backoff. */
export async function readModelsDevPrices(options: ModelsDevOptions = {}): Promise<ModelsDevPrices | undefined> {
  const clock = options.now ?? Date.now
  const at = clock()
  if (cached && at - cached.at < TTL_MS) return cached.prices
  if (inFlight) return inFlight
  if (at < backoffUntil) return cached && at - cached.at <= STALE_MS ? cached.prices : undefined
  failureLogged = false
  inFlight = (async () => {
    try {
      const prices = await fetchPrices(options)
      cached = { at: clock(), prices }
      backoffUntil = 0
      failureLogged = false
      return prices
    } catch {
      backoffUntil = clock() + BACKOFF_MS
      if (!failureLogged) {
        failureLogged = true
        console.warn("[quartermaster] model price fetch unavailable")
      }
      return cached && clock() - cached.at <= STALE_MS ? cached.prices : undefined
    } finally {
      inFlight = undefined
    }
  })()
  return inFlight
}
