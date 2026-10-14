import { readFile } from "node:fs/promises"
import { applyProjectQuartermasterOptions, readProjectQuartermasterOptions } from "./project-options.ts"
import { createServer } from "node:http"
import { isIP } from "node:net"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const page = new URL("../web/index.html", import.meta.url)
const loopback = new Set(["127.0.0.1"])
const maxResponseBytes = 2_000_000

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
        send(res, 200, { revision: loaded.revision, options: loaded.options, writable: loaded.writable })
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
        await applyProjectQuartermasterOptions({ directory, options: body.options, revision: body.revision, readConfiguration })
        const loaded = await readProjectQuartermasterOptions(directory, readConfiguration)
        send(res, 200, { revision: loaded.revision, options: loaded.options })
      } catch (error) {
        const message = error instanceof Error ? error.message : "options"
        send(res, /unknown field|JSON|unterminated|Expected|refusing/.test(message) ? 409 : 400, { error: message })
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { OPENCODE_URL: openCodeURL, OPENCODE_TOKEN: token, QUARTERMASTER_PROJECT_DIR: projectDirectory } = process.env
  if (!openCodeURL || !token || !projectDirectory) {
    console.error("Opt-in only: set OPENCODE_URL, OPENCODE_TOKEN, and QUARTERMASTER_PROJECT_DIR.")
    process.exitCode = 1
  } else {
    const port = Number(process.env.QUARTERMASTER_LOCAL_UI_PORT ?? 4175)
    const server = createLocalUiServer({ openCodeURL, token, projectDirectory, port })
    server.listen(port, "127.0.0.1", () => console.log(`Quartermaster local UI: http://127.0.0.1:${server.address().port}/`))
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close())
  }
}
