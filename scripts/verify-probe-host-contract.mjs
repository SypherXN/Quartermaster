// Isolated contract check for the session-free probe transport.
//
// Questions this answers with a real 2.0.31 host and a loopback fake provider:
//  1. Does one ctx.generate.text produce exactly one provider request, or does the
//     host retry the failed generation internally (several request slots)?
//  2. Does the host deliver a model.request hook event for a session-free generate?
//     If it does, with which kind and sessionID? (Quartermaster only acts on kind === "primary".)
//
// It contacts only its loopback fake provider. Usage: node scripts/verify-probe-host-contract.mjs
//
// The observer plugin is a plain default export (no "@opencode/plugin" import, no Plugin.define:
// define() is the identity function, so the exported shape is the same). It logs QM_PROBE
// "plugin-loaded" as its first action so a load failure is distinguishable from a hook that
// never fired, and it always prints the host log tail when the probe does not settle.
import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const root = join(process.env.LOCALAPPDATA ?? "C:\\Users\\mattg\\AppData\\Local", "Temp", "opencode")
await mkdir(root, { recursive: true })
const temp = await mkdtemp(join(root, "qm-probe-"))
const project = join(temp, "project"), home = join(temp, "home")
const requests = []
await mkdir(project, { recursive: true })
await mkdir(home, { recursive: true })

let previousRequestAt = 0
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body = {}
  try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { /* body is not JSON */ }
  const at = Date.now()
  const entry = {
    model: body.model ?? null,
    at,
    gapMs: previousRequestAt === 0 ? null : at - previousRequestAt,
    // The header tells us whether the host attributes a session id to a stateless call.
    sessionHeader: req.headers["x-opencode-session"] ?? null,
    url: req.url ?? null,
  }
  requests.push(entry)
  previousRequestAt = at
  console.log("QM_PROVIDER " + JSON.stringify({ source: "provider-request", model: entry.model,
    gapMs: entry.gapMs, sessionHeader: entry.sessionHeader, url: entry.url }))
  // The Zen free tier shape the host classifies as a retryable rate limit.
  res.writeHead(429, { "content-type": "application/json" })
  res.end(JSON.stringify({ code: null, message: "OpenCode Zen: Rate limit exceeded. Please try again later.", type: "rate_limit_error" }))
})
await new Promise((resolveListen, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", resolveListen)
})

const config = {
  "$schema": "https://opencode.ai/config.json", model: "local/primary",
  agents: { "probe-check": { mode: "primary", model: "local/primary", system: "Answer with one word." } },
  providers: { local: {
    name: "Local probe test", package: "@opencode/ai/providers/openai-compatible", env: ["QM_LOCAL_API_KEY"],
    settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1` },
    models: { primary: { name: "Primary", modelID: "primary" } },
  } },
  plugins: [{ package: resolve(".") }, join(project, "observer")],
}
await writeFile(join(project, "opencode.json"), JSON.stringify(config, null, 2))
await writeFile(join(project, "quartermaster.jsonc"), JSON.stringify({
  plans: { "probe-test": ["local/primary"] },
  agents: { "probe-check": "probe-test" },
}))
await mkdir(join(project, "observer"))
await writeFile(join(project, "observer", "index.ts"), `
export default {
  id: "qm-probe-observer",
  async setup(ctx) {
    const log = (payload) => console.warn("QM_PROBE " + JSON.stringify(payload))
    log({ source: "plugin-loaded" })
    let requestHook
    try {
      requestHook = await ctx.session.hook("model.request", (e) => {
        log({ source: "model.request", kind: e?.kind ?? null, sessionID: e?.sessionID ?? null,
          agent: e?.agent ?? null, model: e?.model?.id ?? null })
      })
    } catch (err) {
      log({ source: "model.request-hook-error", message: String(err?.message ?? err).slice(0, 300) })
    }
    setTimeout(() => {
      void (async () => {
        const started = Date.now()
        try {
          const result = await ctx.generate.text({ prompt: "Reply with OK.", model: { id: "primary", providerID: "local" } })
          log({ source: "generate", outcome: "resolved", ms: Date.now() - started, text: String(result?.text ?? "").slice(0, 80) })
        } catch (err) {
          log({ source: "generate", outcome: "rejected", ms: Date.now() - started,
            type: err?.type ?? null, status: err?.status ?? null, name: err?.name ?? null,
            message: String(err?.message ?? err).slice(0, 300),
            data: JSON.stringify(err?.data ?? null)?.slice(0, 300) })
        }
      })()
    }, 3000)
    return async () => { await requestHook?.dispose() }
  },
}
`)

const env = Object.fromEntries(Object.entries({
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ComSpec: process.env.ComSpec,
  TEMP: home, TMP: home, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"), XDG_CONFIG_HOME: join(home, ".config"), QM_LOCAL_API_KEY: "fake-only",
  OPENCODE_SERVER_PASSWORD: "isolated-fixture-only",
}).filter(([, value]) => value !== undefined))

let stdout = "", stderr = ""
let child
let settled = false
let observerLoaded = false
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
try {
  const executable = join(homedir(), ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode")
  const version = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true })
  assertVersion(version)
  const port = await freePort()
  child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
    cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })

  const location = `location%5Bdirectory%5D=${encodeURIComponent(project)}`
  const api = async (method, path) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}?${location}`, {
      method, headers: { authorization: `Basic ${Buffer.from("opencode:isolated-fixture-only").toString("base64")}` },
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${response.status}: ${text}`)
    return text ? JSON.parse(text) : undefined
  }
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { await api("GET", "/api/agent"); ready = true; break } catch { /* not up yet */ }
    await delay(200)
  }
  if (!ready) throw new Error("isolated serving process must become ready")

  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    await delay(500)
    const lines = log()
    if (lines.some((line) => line.includes('"source":"plugin-loaded"'))) observerLoaded = true
    if (lines.some((line) => line.includes('"source":"generate"'))) { settled = true; break }
  }
  const observations = log()
  observerLoaded = observerLoaded || observations.some((line) => line.includes('"source":"plugin-loaded"'))
  const modelRequest = observations.filter((line) => line.includes('"source":"model.request"'))
  console.log(observations.join("\n"))
  console.log(JSON.stringify({
    settled,
    observerLoaded,
    providerRequests: requests.length,
    requestGapsMs: requests.slice(1).map((entry, index) => entry.at - requests[index].at),
    providerModels: requests.map((entry) => entry.model),
    providerSessionHeaders: requests.map((entry) => entry.sessionHeader),
    modelRequestEvents: modelRequest.length,
    modelRequestKinds: modelRequest.map((line) => {
      try { return JSON.parse(line.slice(line.indexOf("{")).trim()).kind ?? null } catch { return null }
    }),
    modelRequestSessionIDs: modelRequest.map((line) => {
      try { return JSON.parse(line.slice(line.indexOf("{")).trim()).sessionID ?? null } catch { return null }
    }),
  }, null, 2))
  if (!settled) {
    console.error("No generate outcome was observed within the budget.")
    console.error("--- host log tail ---")
    console.error((stdout + "\n" + stderr).split(/\r?\n/).slice(-120).join("\n"))
  }
  console.log(settled
    ? `Probe contract observed: ${requests.length} provider request(s) for one generate.text; ${modelRequest.length} model.request event(s).`
    : "Probe contract UNVERIFIED within the budget.")
  if (!settled) process.exitCode = 1
} finally {
  if (child?.pid && child.exitCode === null) {
    const closed = new Promise((resolveClose) => child.once("close", resolveClose))
    if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    else child.kill("SIGTERM")
    await closed
  }
  await new Promise((resolveClose) => server.close(resolveClose))
  if (settled) await rm(temp, { recursive: true, force: true })
  console.log(`Fixture artifacts ${settled ? "removed" : "retained for diagnosis"}: ${temp}`)
}

function log() {
  return (stdout + "\n" + stderr).split(/\r?\n/).filter((line) => line.includes("QM_PROBE"))
}

function assertVersion(version) {
  if (version.status !== 0) throw new Error(`opencode --version failed: ${version.stderr}`)
  if (!/2\.0\.31/.test(version.stdout)) throw new Error(`expected OpenCode 2.0.31, got ${version.stdout.trim()}`)
}

async function freePort() {
  const probe = createServer()
  await new Promise((resolveListen) => probe.listen(0, "127.0.0.1", resolveListen))
  const port = probe.address().port
  await new Promise((resolveClose) => probe.close(resolveClose))
  return port
}
