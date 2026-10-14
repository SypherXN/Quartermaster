import { request as httpsRequest } from "node:https"
import { connect } from "node:net"
import type { ModelRef } from "./config.ts"
import { modelKey, type ModelEligibility } from "./select.ts"

export type LocalHealthStatus = "online" | "offline"
export let lastLoopbackDetail = ""

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
      // The managed host's fetch and HTTP client do not complete loopback probes. A raw socket does.
      const status = this.fetcher === fetch
        ? await loopbackStatus(endpoint, this.timeoutMs)
        : await injectedStatus(this.fetcher, endpoint, this.timeoutMs)
      const online = status >= 200 && status < 300
      lastLoopbackDetail = online ? "" : `HTTP ${status}`
      return online ? "online" : "offline"
    } catch (error) {
      const message = error instanceof Error ? error.message : "health probe failed"
      lastLoopbackDetail = message.replace(/\s+/g, " ").slice(0, 160)
      return "offline"
    }
  }
}

async function injectedStatus(fetcher: typeof fetch, endpoint: string, timeoutMs: number): Promise<number> {
  const response = await fetcher(endpoint, {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(Math.min(timeoutMs, 2_147_483_647)),
  })
  return response.status
}

function loopbackStatus(endpoint: string, timeoutMs: number): Promise<number> {
  const url = new URL(endpoint)
  if (url.protocol === "https:") return httpsStatus(url, timeoutMs)
  const port = Number(url.port || 80)
  const timeout = Math.min(Math.max(timeoutMs, 1), 2_147_483_647)
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port })
    let raw = ""
    let settled = false
    const timer = setTimeout(() => finish(new Error(`local health timed out after ${raw.length} bytes`)), timeout)
    const finish = (error?: Error, status?: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(status ?? 0)
    }
    const take = (chunk: Buffer | string | null) => {
      if (chunk == null) return
      raw += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1")
      const status = raw.match(/HTTP\/1\.[01] (\d{3})/)?.[1]
      if (status) finish(undefined, Number(status))
    }
    // Bun leaves this socket paused, so a flowing "data" listener never sees the reply.
    socket.on("readable", () => {
      let chunk: Buffer | string | null
      while ((chunk = socket.read()) !== null) take(chunk)
    })
    socket.on("error", (error) => finish(error))
    socket.on("connect", () => {
      const path = `${url.pathname || "/"}${url.search}`
      socket.write(`GET ${path} HTTP/1.0\r\nHost: ${url.host}\r\nAccept: */*\r\nConnection: close\r\n\r\n`)
    })
  })
}

function httpsStatus(url: URL, timeoutMs: number): Promise<number> {
  const timeout = Math.min(Math.max(timeoutMs, 1), 2_147_483_647)
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "GET", headers: { accept: "*/*", connection: "close" } }, (res) => {
      clearTimeout(timer)
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    const timer = setTimeout(() => req.destroy(new Error("local health timed out")), timeout)
    req.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    req.end()
  })
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
