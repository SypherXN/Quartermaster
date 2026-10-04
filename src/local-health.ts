import type { ModelRef } from "./config.ts"
import { modelKey, type ModelEligibility } from "./select.ts"

export type LocalHealthStatus = "online" | "offline"

const CACHE_MS = 5_000

export class LocalHealth {
  private readonly cache = new Map<string, { status: LocalHealthStatus; expiresAt: number }>()
  private readonly pending = new Map<string, Promise<LocalHealthStatus>>()
  private readonly endpoints: Readonly<Record<string, string>>
  private readonly timeoutMs: number
  private readonly fetcher: typeof fetch
  private readonly cacheMs: number

  constructor(
    endpoints: Readonly<Record<string, string>>,
    timeoutMs: number,
    fetcher: typeof fetch = fetch,
    cacheMs = CACHE_MS,
  ) {
    this.endpoints = endpoints
    this.timeoutMs = timeoutMs
    this.fetcher = fetcher
    this.cacheMs = cacheMs
  }

  async check(
    providerID: string,
    { now = Date.now(), force = false }: { now?: number; force?: boolean } = {},
  ): Promise<LocalHealthStatus | undefined> {
    if (!Object.hasOwn(this.endpoints, providerID)) return undefined
    const endpoint = this.endpoints[providerID]
    if (endpoint === undefined) return undefined

    const cached = this.cache.get(providerID)
    if (!force && cached && now < cached.expiresAt) return cached.status

    const inFlight = this.pending.get(providerID)
    if (inFlight) return inFlight

    const request = this.probe(endpoint)
    this.pending.set(providerID, request)
    try {
      const status = await request
      this.cache.set(providerID, { status, expiresAt: now + this.cacheMs })
      return status
    } finally {
      this.pending.delete(providerID)
    }
  }

  async checkAll(
    providers: Iterable<string>,
    options?: { now?: number; force?: boolean },
  ): Promise<ReadonlyMap<string, LocalHealthStatus>> {
    const checks = [...new Set(providers)].filter((provider) => Object.hasOwn(this.endpoints, provider))
    const results = await Promise.all(checks.map(async (provider) => [
      provider,
      await this.check(provider, options),
    ] as const))
    return new Map(results.filter((entry): entry is readonly [string, LocalHealthStatus] => entry[1] !== undefined))
  }

  private async probe(endpoint: string): Promise<LocalHealthStatus> {
    try {
      const response = await this.fetcher(endpoint, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 2_147_483_647)),
      })
      return response.ok ? "online" : "offline"
    } catch {
      return "offline"
    }
  }
}

export function applyLocalHealth(
  registry: readonly ModelRef[],
  eligibility: ReadonlyMap<string, ModelEligibility>,
  health: ReadonlyMap<string, LocalHealthStatus>,
): ReadonlyMap<string, ModelEligibility> {
  const result = new Map(eligibility)
  for (const model of registry) {
    if (health.get(model.providerID) !== "offline") continue
    const key = modelKey(model)
    const current = result.get(key)
    if (current) result.set(key, { ...current, localOffline: true })
  }
  return result
}
