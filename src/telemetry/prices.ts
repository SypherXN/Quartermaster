// Catalog pricing for token costs. The host exposes prices only through the
// async model catalog, so the report reads them through a short-lived cache.

export interface CatalogPrice {
  // null means the price applies regardless of context size.
  tierSize: number | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type PriceTable = ReadonlyMap<string, readonly CatalogPrice[]>

export interface CatalogModelLike {
  providerID?: string
  modelID?: string
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
        cacheWrite,
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

// ponytail: one process-wide cache with a TTL; a catalog that changes mid-call
// is at most TTL stale, which only affects an estimate.
const TTL_MS = 60_000
export interface CatalogSnapshot {
  prices: PriceTable
  contextLimits: ReadonlyMap<string, number>
}
const emptySnapshot = (): CatalogSnapshot => ({ prices: new Map(), contextLimits: new Map() })
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
  return { prices: pricesFromModels(models), contextLimits }
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
