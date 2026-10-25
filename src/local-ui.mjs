import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { applyDiscoveredQuartermasterOptions, readProjectQuartermasterOptions } from "./project-options.ts"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { isIP } from "node:net"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const page = new URL("../web/index.html", import.meta.url)
const loopback = new Set(["127.0.0.1"])
const maxResponseBytes = 2_000_000

function optionsBody(loaded) {
  return {
    revision: loaded.revision,
    options: loaded.options,
    // A discovered settings path is writable here. The plugin reader still reports inherited files as read-only.
    writable: loaded.writable === true || typeof loaded.path === "string",
    ...(typeof loaded.path === "string" ? { path: loaded.path } : {}),
  }
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" })
  res.end(typeof body === "string" ? body : JSON.stringify(body))
}

async function readLimited(response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("empty")
  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxResponseBytes) {
      await reader.cancel()
      throw new Error("too large")
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString()
}

export function createLocalUiServer({ openCodeURL, token, projectDirectory, port = 4175 }) {
  const upstream = new URL(openCodeURL)
  if (!loopback.has(upstream.hostname) || !["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash)
    throw new Error("OpenCode URL must use the 127.0.0.1 loopback HTTP(S) origin without embedded credentials")
  if (!token?.trim() || !projectDirectory?.trim()) throw new Error("OpenCode token and project directory are required")
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid local UI port")
  const authorization = `Basic ${Buffer.from(`opencode:${token}`).toString("base64")}`
  const directory = resolve(projectDirectory)
  const sameDirectory = (value) => {
    const found = resolve(value)
    return found === directory || found.toLowerCase() === directory.toLowerCase()
  }
  async function upstreamJSON(url, { method = "GET", body } = {}) {
    const response = await fetch(url, {
      method, body, redirect: "error", signal: AbortSignal.timeout(5_000),
      headers: { authorization, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    })
    if (!response.ok) throw new Error("upstream")
    return JSON.parse(await readLimited(response))
  }
  async function projectIDForDirectory() {
    const endpoint = new URL("/api/location", upstream)
    endpoint.searchParams.set("location[directory]", directory)
    const body = await upstreamJSON(endpoint)
    const found = body?.directory ?? body?.project?.directory
    if (typeof body?.project?.id !== "string" || !body.project.id || typeof found !== "string" || !sameDirectory(found))
      throw new Error("project")
    return body.project.id
  }
  function scopedEnvelope(body, projectID) {
    const location = body?.location
    const found = location?.directory ?? location?.project?.directory
    return (!found || (typeof found === "string" && sameDirectory(found))) &&
      (!location?.project?.id || location.project.id === projectID)
  }
  function providerCatalog(providers, models) {
    if (!Array.isArray(providers) || !Array.isArray(models)) throw new Error("catalog")
    const byProvider = new Map()
    for (const model of models) {
      if (!model || typeof model !== "object" || typeof model.id !== "string" || !model.id ||
        typeof model.providerID !== "string" || !model.providerID || typeof model.name !== "string") throw new Error("catalog")
      if (model.variants !== undefined && (!Array.isArray(model.variants) || model.variants.some((variant) => !variant || typeof variant.id !== "string"))) throw new Error("catalog")
      const limit = model.limit
      const capabilities = model.capabilities
      const cost = Array.isArray(model.cost) ? model.cost.flatMap((row) => {
        if (!row || !Number.isFinite(row.input) || row.input < 0 || !Number.isFinite(row.output) || row.output < 0 ||
          !row.cache || !Number.isFinite(row.cache.read) || row.cache.read < 0 ||
          !Number.isFinite(row.cache.write) || row.cache.write < 0) return []
        const projected = { input: row.input, output: row.output, cache: { read: row.cache.read, write: row.cache.write } }
        if (Object.hasOwn(row, "tier")) {
          if (!row.tier || row.tier.type !== "context" || !Number.isSafeInteger(row.tier.size) || row.tier.size < 0) return []
          projected.tier = { type: "context", size: row.tier.size }
        }
        return [projected]
      }) : undefined
      const safeCapabilities = {
        ...(typeof capabilities?.tools === "boolean" ? { tools: capabilities.tools } : {}),
        ...(Array.isArray(capabilities?.input) && capabilities.input.every((value) => typeof value === "string") ? { input: capabilities.input } : {}),
        ...(Array.isArray(capabilities?.output) && capabilities.output.every((value) => typeof value === "string") ? { output: capabilities.output } : {}),
        ...(typeof capabilities?.temperature === "boolean" ? { temperature: capabilities.temperature } : {}),
      }
      const safeModel = {
        id: model.id, name: model.name,
        ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
        ...(typeof model.enabled === "boolean" ? { enabled: model.enabled } : {}),
        variants: (model.variants ?? []).map(({ id }) => id),
        ...(Number.isSafeInteger(limit?.context) && limit.context >= 0 ? { context: limit.context } : {}),
        ...(Number.isSafeInteger(limit?.input) && limit.input >= 0 ? { input: limit.input } : {}),
        ...(Number.isSafeInteger(limit?.output) && limit.output >= 0 ? { output: limit.output } : {}),
        ...(Object.keys(safeCapabilities).length ? { capabilities: safeCapabilities } : {}),
        ...(cost?.length ? { cost } : {}),
      }
      const list = byProvider.get(model.providerID) ?? []
      list.push(safeModel)
      byProvider.set(model.providerID, list)
    }
    return providers.map((provider) => {
      if (!provider || typeof provider !== "object" || typeof provider.id !== "string" || !provider.id || typeof provider.name !== "string") throw new Error("catalog")
      return { id: provider.id, name: provider.name, models: byProvider.get(provider.id) ?? [] }
    })
  }
  async function rpc(method, input) {
    const endpoint = new URL(`/api/rpc/quartermaster/${method}`, upstream)
    endpoint.searchParams.set("location[directory]", directory)
    const body = await upstreamJSON(endpoint, { method: "POST", body: JSON.stringify({ input }) })
    return body?.output
  }
  async function readConfiguration() {
    await projectIDForDirectory()
    const endpoint = new URL("/api/config", upstream)
    endpoint.searchParams.set("location[directory]", directory)
    const sources = await upstreamJSON(endpoint)
    if (!Array.isArray(sources)) throw new Error("Configuration provenance is unavailable")
    return sources
  }

  let server
  server = createServer(async (req, res) => {
    const address = req.socket.remoteAddress === "::ffff:127.0.0.1" ? "127.0.0.1" : req.socket.remoteAddress
    if (address !== "127.0.0.1" || isIP(address) !== 4) return send(res, 403, { error: "local requests only" })
    const listeningPort = server.address()?.port ?? port
    const host = `127.0.0.1:${listeningPort}`
    const site = req.headers["sec-fetch-site"]
    const topLevelPage = req.method === "GET" && req.url === "/" && site === "none"
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`) ||
      (site && site !== "same-origin" && !topLevelPage))
      return send(res, 403, { error: "same-origin requests only" })

    if (req.method === "GET" && req.url === "/") {
      try {
        const html = await readFile(page)
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
          "content-security-policy": "default-src 'self'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        })
        res.end(html)
      } catch {
        send(res, 500, { error: "local page unavailable" })
      }
      return
    }
    if (req.method === "GET" && req.url === "/api/options") {
      try {
        const loaded = await readProjectQuartermasterOptions(directory, readConfiguration)
        send(res, 200, optionsBody(loaded))
      } catch (error) {
        send(res, 409, { error: error instanceof Error ? error.message : "options" })
      }
      return
    }
    if (req.method === "POST" && req.url === "/api/options") {
      try {
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 100_000) return send(res, 413, { error: "options are too large" })
          chunks.push(chunk)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString())
        if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.revision !== "number" || !body.options || typeof body.options !== "object" || Array.isArray(body.options))
          return send(res, 400, { error: "expected options and revision" })
        await applyDiscoveredQuartermasterOptions({ directory, options: body.options, revision: body.revision, readConfiguration })
        const loaded = await readProjectQuartermasterOptions(directory, readConfiguration)
        send(res, 200, optionsBody(loaded))
      } catch (error) {
        const message = error instanceof Error ? error.message : "options"
        send(res, /unknown field|JSON|unterminated|Expected|refusing/.test(message) ? 409 : 400, { error: message })
      }
      return
    }
    if (req.method === "GET" && req.url === "/api/providers") {
      try {
        const projectID = await projectIDForDirectory()
        const providerURL = new URL("/api/provider", upstream)
        const modelURL = new URL("/api/model", upstream)
        for (const endpoint of [providerURL, modelURL]) endpoint.searchParams.set("location[directory]", directory)
        const [providerBody, modelBody] = await Promise.all([upstreamJSON(providerURL), upstreamJSON(modelURL)])
        if (!scopedEnvelope(providerBody, projectID) || !scopedEnvelope(modelBody, projectID) ||
          !Array.isArray(providerBody?.data) || !Array.isArray(modelBody?.data)) throw new Error("catalog")
        send(res, 200, { apiVersion: 1, generatedAt: new Date().toISOString(), providers: providerCatalog(providerBody.data, modelBody.data) })
      } catch {
        send(res, 502, { error: "Provider catalog unavailable" })
      }
      return
    }
    if (req.method === "GET" && req.url === "/api/dashboard") {
      try {
        const projectID = await projectIDForDirectory()
        const [plans, reportResult] = await Promise.all([
          rpc("status", {}).catch(() => null),
          rpc("report", { limit: 50, offset: 0 }).catch(() => null),
        ])
        if (plans?.apiVersion !== 1 || !plans.plans || !plans.agents || !plans.workTypes)
          return send(res, 502, { error: "Quartermaster status unavailable" })
        const sources = plans.availability?.sources ?? plans.sources ?? {}
        if (!sources || typeof sources !== "object" || Array.isArray(sources)) throw new Error("status")
        const status = Object.entries(sources).map(([providerID, source]) => {
          if (!source || typeof source !== "object" ||
            (source.sourceID !== undefined && !["go", "codex", "cursor"].includes(source.sourceID)) ||
            (source.authenticated !== undefined && typeof source.authenticated !== "boolean") || typeof source.stale !== "boolean" ||
            !["available", "limited", "unknown"].includes(source.availability) ||
            !(source.checkedAt === undefined || source.checkedAt === null || Number.isFinite(source.checkedAt)) ||
            !(source.nextAvailableAt === undefined || source.nextAvailableAt === null || Number.isFinite(source.nextAvailableAt)) ||
            !(source.windows === undefined || Array.isArray(source.windows))) throw new Error("status")
          const windows = (source.windows ?? []).map((window) => {
            if (!window || typeof window.name !== "string" ||
              !(window.usedPercent === null || Number.isFinite(window.usedPercent)) ||
              !["ok", "rate-limited", "unknown"].includes(window.state) ||
              !(window.resetsAt === undefined || window.resetsAt === null || Number.isFinite(window.resetsAt))) throw new Error("status")
            return { name: window.name, usedPercent: window.usedPercent, state: window.state,
              resetsAt: window.resetsAt, ...(typeof window.resetEstimated === "boolean" ? { resetEstimated: window.resetEstimated } : {}) }
          })
          return { providerID, ...(source.sourceID ? { sourceID: source.sourceID } : {}),
            ...(typeof source.authenticated === "boolean" ? { authenticated: source.authenticated } : {}),
            checkedAt: source.checkedAt ?? null, stale: source.stale,
            availability: source.availability ?? source.status ?? "unknown",
            ...(source.nextAvailableAt === undefined ? {} : { nextAvailableAt: source.nextAvailableAt }), windows }
        })
        const report = reportResult?.apiVersion === 1 && reportResult.status === "ok" &&
          reportResult.projectID === projectID && reportResult.totals && reportResult.costs ? reportResult : null
        const cooldowns = Array.isArray(plans.failureCooldowns)
          ? plans.failureCooldowns.filter((item) => item && typeof item.providerID === "string" && Number.isFinite(item.until))
            .map(({ providerID, modelID, until }) => ({ providerID, ...(typeof modelID === "string" ? { modelID } : {}), until }))
          : undefined
        send(res, 200, { apiVersion: 1, projectID, generatedAt: new Date().toISOString(),
          plans: plans.plans, agents: plans.agents, workTypes: plans.workTypes,
          availability: { status: plans.availability?.quota ?? plans.status ?? "unknown",
            ...(Number.isFinite(plans.availability?.quotaUpdatedAt) ? { updatedAt: plans.availability.quotaUpdatedAt } :
              Number.isFinite(plans.updatedAt) ? { updatedAt: plans.updatedAt } : {}),
            ...(typeof plans.reason === "string" ? { reason: plans.reason } : {}),
            sources: Object.fromEntries(status.map(({ providerID, ...source }) => [providerID, source])) },
          ...(cooldowns ? { cooldowns } : {}), report,
          ...(!report ? { reportError: "Quartermaster report unavailable" } : {}) })
      } catch {
        send(res, 502, { error: "Quartermaster status unavailable" })
      }
      return
    }
    if (req.method !== "GET" || req.url !== "/api/report") return send(res, 404, { error: "not found" })

    try {
      const projectID = await projectIDForDirectory()
      const output = await rpc("report", { limit: 50, offset: 0 })
      const plans = await rpc("status", {})
      if (output?.apiVersion !== 1 || output?.status !== "ok" || output?.projectID !== projectID || !output.totals || !output.costs)
        return send(res, 502, { error: "Quartermaster report unavailable" })
      if (plans?.apiVersion !== 1 || !plans.plans || !plans.agents || !plans.workTypes)
        return send(res, 502, { error: "Quartermaster report unavailable" })
      send(res, 200, {
        ...output,
        plans: plans.plans,
        agents: plans.agents,
        workTypes: plans.workTypes,
        availability: { status: plans.status, reason: plans.reason, sources: plans.sources, updatedAt: plans.updatedAt },
      })
    } catch {
      send(res, 502, { error: "Quartermaster report unavailable" })
    }
  })
  server.on("error", (error) => console.error("Quartermaster local UI stopped:", error.message))
  return server
}

async function localService() {
  const info = JSON.parse(await readFile(resolve(homedir(), ".local", "state", "opencode", "service.json"), "utf8"))
  const url = new URL(info.url)
  if (url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]") url.hostname = "127.0.0.1"
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname !== "127.0.0.1" || !url.port)
    throw new Error("OpenCode service is not a loopback HTTP port")
  const token = info.password
  if (typeof token !== "string" || token.trim() === "") throw new Error("OpenCode service has no local password")
  return { openCodeURL: `http://127.0.0.1:${url.port}`, token }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.stdout.isTTY && process.env.QUARTERMASTER_GATEWAY_CHILD !== "1") {
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: { ...process.env, QUARTERMASTER_GATEWAY_CHILD: "1" },
    })
    child.unref()
    const port = process.env.QUARTERMASTER_LOCAL_UI_PORT ?? "4175"
    console.log(`Quartermaster local UI: http://127.0.0.1:${port}/#plans`)
    process.exit(0)
  }
  const projectDirectory = process.env.QUARTERMASTER_PROJECT_DIR
  if (!projectDirectory) {
    console.error("Opt-in only: set QUARTERMASTER_PROJECT_DIR.")
    process.exitCode = 1
  } else {
    Promise.resolve().then(async () => {
      let openCodeURL = process.env.OPENCODE_URL
      let token = process.env.OPENCODE_TOKEN
      if (!openCodeURL || !token) {
        const discovered = await localService()
        openCodeURL = openCodeURL || discovered.openCodeURL
        token = token || discovered.token
      }
      const port = Number(process.env.QUARTERMASTER_LOCAL_UI_PORT ?? 4175)
      const server = createLocalUiServer({ openCodeURL, token, projectDirectory, port })
      server.listen(port, "127.0.0.1", () => {
        const origin = `http://127.0.0.1:${server.address().port}`
        console.log(`Quartermaster local UI: ${origin}/`)
        spawn("cmd", ["/c", "start", "", `${origin}/#plans`], { stdio: "ignore", windowsHide: true }).unref()
        fetch(`${origin}/api/options`, { headers: { origin, "sec-fetch-site": "same-origin" } }).then(async (response) => {
          const body = await response.json()
          const count = body?.options?.plans && typeof body.options.plans === "object" ? Object.keys(body.options.plans).length : 0
          console.log(`Plans endpoint ${response.status}; writable ${body.writable === true}; plans ${count}${typeof body.error === "string" && body.error ? `; ${body.error}` : ""}`)
        }).catch((error) => console.error(error instanceof Error ? error.message : "plans endpoint failed"))
      })
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close())
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : "local UI failed")
      process.exitCode = 1
    })
  }
}
