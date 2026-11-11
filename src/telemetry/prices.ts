// Catalog pricing for token costs. The host exposes prices only through the
// async model catalog, so the report reads them through a short-lived cache.
import { peekModelsDevPrices, readModelsDevPrices, type ModelsDevPrices } from "./models-dev.ts"

export interface CatalogPrice {
  // null means the price applies regardless of context size.
  tierSize: number | null
  input: number
  output: number
  cacheRead: number
  cacheReadKnown?: boolean
  cacheWrite: number
  cacheWriteKnown?: boolean
}

export type PriceTable = ReadonlyMap<string, readonly CatalogPrice[]>

export interface CatalogModelLike {
  providerID?: string
  modelID?: string
  // Catalog route ID. Routing and the local UI key models by this when present;
  // the ordinary cost parser intentionally keeps using `modelID`.
  id?: string
  name?: unknown
  limit?: { context?: unknown }
  cost?: readonly {
    tier?: { type?: string; size?: unknown }
    input: unknown
    output: unknown
    cache?: { read?: unknown; write?: unknown }
  }[]
}

const amount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

export function pricesFromModels(models: readonly CatalogModelLike[]): Map<string, CatalogPrice[]> {
  const table = new Map<string, CatalogPrice[]>()
  for (const model of models) {
    if (!model.providerID || !model.modelID || !Array.isArray(model.cost)) continue
    const rows: CatalogPrice[] = []
    for (const row of model.cost) {
      const input = amount(row?.input)
      const output = amount(row?.output)
      const cacheRead = amount(row?.cache?.read) ?? 0
      const cacheWrite = amount(row?.cache?.write) ?? 0
      if (input === undefined || output === undefined) continue
      const size = row?.tier?.type === "context" ? amount(row.tier.size) : undefined
      rows.push({
        tierSize: size !== undefined && Number.isSafeInteger(size) ? size : null,
        input,
        output,
        cacheRead,
        cacheReadKnown: amount(row?.cache?.read) !== undefined,
        cacheWrite,
        cacheWriteKnown: amount(row?.cache?.write) !== undefined,
      })
    }
    if (rows.length) table.set(`${model.providerID}/${model.modelID}`, rows)
  }
  return table
}

export function selectPrice(rows: readonly CatalogPrice[] | undefined, contextTokens: number): CatalogPrice | undefined {
  if (!rows?.length) return undefined
  let best: CatalogPrice | undefined
  for (const row of rows) {
    if (row.tierSize === null) { best ??= row; continue }
    if (row.tierSize > contextTokens) continue
    if (!best || best.tierSize === null || row.tierSize > best.tierSize) best = row
  }
  return best
}

interface QuotaPriceEquivalent {
  sourceProvider: string
  sourceModel: string
  // Claude aliases are generation-specific; a retargeted alias must not borrow
  // another generation's prices. OpenAI IDs are exact and need no name guard.
  sourceName?: string
  targetProvider: string
  targetModel: string
  targetName?: string
}

const QUOTA_PRICE_EQUIVALENTS: readonly QuotaPriceEquivalent[] = [
  { sourceProvider: "openai", sourceModel: "gpt-6-luna", targetProvider: "opencode", targetModel: "gpt-6-luna" },
  { sourceProvider: "openai", sourceModel: "gpt-6.1-sol", targetProvider: "opencode", targetModel: "gpt-6.1-sol" },
  { sourceProvider: "openai", sourceModel: "gpt-6-astra", targetProvider: "opencode", targetModel: "gpt-6-astra" },
  {
    sourceProvider: "claude-agent", sourceModel: "opus", sourceName: "Opus 5.5",
    targetProvider: "opencode", targetModel: "claude-opus-5-5", targetName: "Claude Opus 5.5",
  },
  {
    sourceProvider: "claude-agent", sourceModel: "sonnet", sourceName: "Sonnet 5.5",
    targetProvider: "opencode", targetModel: "claude-sonnet-5-5", targetName: "Claude Sonnet 5.5",
  },
  {
    sourceProvider: "claude-agent", sourceModel: "haiku", sourceName: "Haiku 5.5",
    targetProvider: "opencode", targetModel: "claude-haiku-5-5", targetName: "Claude Haiku 5.5",
  },
]

const ROLLING_CLAUDE_FAMILIES: ReadonlyMap<string, string> = new Map([
  ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"], ["fable", "Fable"],
])

const hasPositivePrice = (rows: readonly CatalogPrice[] | undefined): rows is readonly CatalogPrice[] =>
  rows !== undefined && rows.some((row) => row.input > 0 || row.output > 0 || row.cacheRead > 0 || row.cacheWrite > 0)

/**
 * API-equivalent prices for quota and usage comparison only. Ordinary cost
 * reporting keeps using `pricesFromModels`; this table copies a known priced
 * equivalent under a subscription key only when that subscription model really
 * exists. Rolling Claude families prefer the newest stable fetched API family;
 * explicit IDs and the static aliases keep their exact-name guards, and the
 * static equivalents are fallback only when family metadata is unavailable.
 *
 * ponytail: six verified equivalents, no fuzzy family/name matching. A catalog
 * rename or retarget simply leaves the subscription model unpriced.
 */
export function quotaPricesFromModels(
  models: readonly CatalogModelLike[],
  apiPrices?: ModelsDevPrices,
): Map<string, CatalogPrice[]> {
  const normalized = models.map((model) => {
    const routeID = typeof model.id === "string" && model.id.length > 0 ? model.id : model.modelID
    return routeID === model.modelID ? model : { ...model, modelID: routeID }
  })
  const direct = pricesFromModels(normalized)
  const byKey = new Map<string, CatalogModelLike>()
  for (const model of normalized) {
    if (model.providerID && model.modelID) byKey.set(`${model.providerID}/${model.modelID}`, model)
  }
  const table = new Map<string, CatalogPrice[]>()
  for (const [key, rows] of direct) table.set(key, [...rows])
  const staticBlocked = new Set<string>()
  // Fetched API prices (models.dev) outrank the static host-catalog alias fallback.
  for (const model of normalized) {
    if (model.providerID !== "openai" && model.providerID !== "claude-agent") continue
    if (!model.modelID) continue
    const sourceKey = `${model.providerID}/${model.modelID}`
    if (hasPositivePrice(direct.get(sourceKey))) continue
    let rows: readonly CatalogPrice[] | null | undefined
    if (model.providerID === "openai") {
      rows = apiPrices?.openai.get(model.modelID)
    } else {
      const familyName = ROLLING_CLAUDE_FAMILIES.get(model.modelID)
      const family = familyName === undefined ? undefined : apiPrices?.families?.get(familyName)
      if (familyName !== undefined && family !== undefined) {
        // A known rolling family decides the generation; even an unpriced or
        // ambiguous newest candidate blocks older/static prices.
        staticBlocked.add(sourceKey)
        rows = family.ambiguous ? undefined : family.prices ?? undefined
      } else {
        if (typeof model.name !== "string" || model.name.length === 0) continue
        rows = apiPrices?.anthropicByName.get(`Claude ${model.name}`)
      }
    }
    if (rows === undefined || rows === null || !hasPositivePrice(rows)) continue
    table.set(sourceKey, rows.map((row) => ({ ...row })))
  }
  for (const alias of QUOTA_PRICE_EQUIVALENTS) {
    const sourceKey = `${alias.sourceProvider}/${alias.sourceModel}`
    const source = byKey.get(sourceKey)
    if (!source) continue
    if (alias.sourceName !== undefined && source.name !== alias.sourceName) continue
    if (staticBlocked.has(sourceKey) || hasPositivePrice(table.get(sourceKey))) continue
    const targetKey = `${alias.targetProvider}/${alias.targetModel}`
    const target = byKey.get(targetKey)
    if (!target) continue
    if (alias.targetName !== undefined && target.name !== alias.targetName) continue
    const targetRows = direct.get(targetKey)
    if (!hasPositivePrice(targetRows)) continue
    table.set(sourceKey, targetRows.map((row) => ({ ...row })))
  }
  return table
}

// ponytail: one process-wide cache with a TTL; a catalog that changes mid-call
// is at most TTL stale, which only affects an estimate.
const TTL_MS = 60_000
export interface CatalogSnapshot {
  prices: PriceTable
  // Quota and API-equivalent usage comparison; absent on snapshots built by older callers/tests.
  quotaPrices?: PriceTable
  contextLimits: ReadonlyMap<string, number>
  // Retained so a quota/report read can add fetched API prices.
  models?: readonly CatalogModelLike[]
}
const emptySnapshot = (): CatalogSnapshot => ({ prices: new Map(), quotaPrices: new Map(), contextLimits: new Map() })
let cached: { at: number; snapshot: CatalogSnapshot } | undefined
let pending: Promise<CatalogSnapshot> | undefined

export function resetPriceCache(): void {
  cached = undefined
  pending = undefined
}

export function snapshotFromModels(models: readonly CatalogModelLike[]): CatalogSnapshot {
  const contextLimits = new Map<string, number>()
  for (const model of models) {
    const limit = model.limit?.context
    if (!model.providerID || !model.modelID) continue
    if (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0) {
      contextLimits.set(`${model.providerID}/${model.modelID}`, limit)
    }
  }
  const prices = pricesFromModels(models)
  return { prices, quotaPrices: quotaPricesFromModels(models), contextLimits, models }
}

export async function readCatalogSnapshot(
  list: () => Promise<{ data?: readonly CatalogModelLike[] } | readonly CatalogModelLike[]>,
  now: () => number = Date.now,
): Promise<CatalogSnapshot> {
  const at = now()
  if (cached && at - cached.at < TTL_MS) return cached.snapshot
  if (pending) return pending
  pending = (async () => {
    try {
      const result = await list()
      const listed = result as readonly CatalogModelLike[] | { data?: readonly CatalogModelLike[] }
      const wrapped = listed as { data?: readonly CatalogModelLike[] }
      const models = Array.isArray(listed) ? listed as readonly CatalogModelLike[] : wrapped.data ?? []
      const snapshot = snapshotFromModels(models)
      cached = { at, snapshot }
      return snapshot
    } catch {
      return cached?.snapshot ?? emptySnapshot()
    } finally {
      pending = undefined
    }
  })()
  return pending
}

export async function readPriceTable(
  list: () => Promise<{ data?: readonly CatalogModelLike[] } | readonly CatalogModelLike[]>,
  now: () => number = Date.now,
): Promise<PriceTable> {
  return (await readCatalogSnapshot(list, now)).prices
}

/** API-equivalent prices for quota and usage comparison; cost reports keep `readPriceTable`. */
export interface QuotaPriceOptions {
  fetch?: typeof fetch
  fetchApiPrices?: boolean
  // false: never wait for the network; use cached prices and refresh in the background.
  wait?: boolean
}

export async function readQuotaPriceTable(
  list: () => Promise<{ data?: readonly CatalogModelLike[] } | readonly CatalogModelLike[]>,
  now: () => number = Date.now,
  options: QuotaPriceOptions = {},
): Promise<PriceTable> {
  const snapshot = await readCatalogSnapshot(list, now)
  if (options.fetchApiPrices === false || options.fetch === undefined || !snapshot.models) {
    return snapshot.quotaPrices ?? new Map()
  }
  let apiPrices: ModelsDevPrices | undefined
  try {
    apiPrices = options.wait === false
      ? peekModelsDevPrices({ fetch: options.fetch, now })
      : await readModelsDevPrices({ fetch: options.fetch, now })
  } catch {
    apiPrices = undefined
  }
  return quotaPricesFromModels(snapshot.models, apiPrices)
}
