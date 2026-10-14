import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { homedir, tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

// Disposable stock-host project; no OpenCode server, user settings or auth reads.
const root = process.platform === "win32" ? join(homedir(), "AppData", "Local", "Temp", "opencode") : join(tmpdir(), "opencode")
await mkdir(root, { recursive: true })
const directory = await mkdtemp(join(root, "qm-managed-"))
const pluginRoot = resolve(process.argv.find((arg) => arg.startsWith("--plugin-root="))?.slice(14) ?? ".")
await access(join(pluginRoot, "index.js"))
let pluginPackage = pluginRoot
if (process.argv.includes("--fail-switch")) {
  pluginPackage = join(directory, "switch-fault")
  await mkdir(pluginPackage)
  const adapter = await readFile("scripts/managed-switch-fault/index.ts", "utf8")
  await writeFile(join(pluginPackage, "index.ts"), adapter.replace('"../../index.js"', JSON.stringify(pathToFileURL(join(pluginRoot, "index.js")).href)))
}
const toolProof = process.argv.includes("--tool-proof")
const toolFile = join(directory, "tool-proof.txt")
if (toolProof) await writeFile(toolFile, "QM read-once proof\n")
// Persistent provider cooldowns must not contaminate the next disposable run.
const providers = { initial: `qm-fixture-${basename(directory)}-initial`, selected: `qm-fixture-${basename(directory)}-selected` }
const requests = []
let online = true
let hold = false
let switchFaults = 0
let failure = { mode: "none", remaining: 0, model: null }
const held = new Set()
const text = (content) => typeof content === "string" ? content : Array.isArray(content)
  ? content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : ""
const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return res.writeHead(online ? 200 : 503).end()
  if (req.method === "POST" && req.url === "/offline") { online = false; return res.writeHead(204).end() }
  if (req.method === "POST" && req.url === "/online") { online = true; return res.writeHead(204).end() }
  if (req.method === "POST" && req.url === "/hold") { hold = true; return res.writeHead(204).end() }
  if (req.method === "POST" && req.url === "/switch-fault") { switchFaults++; return res.writeHead(204).end() }
  if (req.method === "POST" && req.url === "/failure") {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
    if (!["none", "rate-limit", "partial", "partial-after-tool"].includes(body.mode)) return res.writeHead(400).end()
    failure = { mode: body.mode, remaining: body.remaining ?? 0, model: body.model ?? null }
    return res.writeHead(204).end()
  }
  if (req.method === "POST" && req.url === "/release") {
    hold = false
    for (const release of held) release()
    return res.writeHead(204).end()
  }
  if (req.method === "GET" && req.url === "/trace") {
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ directory, online, hold, switchFaults, failure, waiting: held.size, requests }, null, 2))
  }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") return res.writeHead(404).end()
  try {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 1_000_000) return res.writeHead(413).end()
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const lastUser = text(body.messages?.findLast((message) => message.role === "user")?.content)
    const marker = lastUser.match(/\bqm-managed-[a-z-]+\b/)?.[0] ?? null
    const auxiliary = body.messages?.some((message) => message.role === "system" && text(message.content).includes("You are a title generator")) ?? false
    const delegated = body.messages?.some((message) => message.role === "tool") ?? false
    const spawnChild = marker === "qm-managed-spawn" && !delegated && !auxiliary
    const emitRead = toolProof && marker === "qm-managed-tool-once" && !delegated && !auxiliary
    const entry = { sequence: requests.length + 1, at: Date.now(), model: body.model, marker, auxiliary, variant: req.headers["x-qm-fixture-variant"] ?? null,
      toolNames: body.tools?.map((tool) => tool.function?.name) ?? [], delegated, spawnChild, emitRead,
      toolResultIDs: body.messages?.filter((message) => message.role === "tool").map((message) => message.tool_call_id) ?? [], failure: null }
    requests.push(entry)
    const armed = failure.remaining > 0 && failure.mode !== "none" && !auxiliary && (failure.model == null || body.model === failure.model)
      && (failure.mode !== "partial-after-tool" || delegated)
    if (armed) {
      failure.remaining -= 1
      entry.failure = failure.mode
      if (failure.mode === "rate-limit") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0" })
        return res.end(JSON.stringify({ error: { message: "local retry", type: "rate_limit_error", code: "rate_limit_exceeded" } }))
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      return res.end(`data: ${JSON.stringify({ id: "managed-fixture", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "PARTIAL" }, finish_reason: null }] })}\n\n`)
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    if (emitRead) {
      const read = body.tools?.find((tool) => tool.function?.name === "read")
      const pathKey = ["path", "filePath"].find((key) => Object.hasOwn(read?.function?.parameters?.properties ?? {}, key))
      if (!pathKey) return res.end()
      res.end([
        `data: ${JSON.stringify({ id: "managed-fixture", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "managed-read-once", type: "function", function: { name: "read", arguments: JSON.stringify({ [pathKey]: toolFile }) } }] }, finish_reason: "tool_calls" }] })}`,
        "data: [DONE]",
      ].join("\n\n") + "\n\n")
      return
    }
    if (spawnChild) {
      res.end([
        `data: ${JSON.stringify({ id: "managed-fixture", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "managed-child", type: "function", function: { name: "subagent", arguments: JSON.stringify({ agent: "qm-managed-child", description: "Managed routing proof", prompt: "qm-managed-child" }) } }] }, finish_reason: "tool_calls" }] })}`,
        "data: [DONE]",
      ].join("\n\n") + "\n\n")
      return
    }
    res.write(`data: ${JSON.stringify({ id: "managed-fixture", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`)
    if (hold && !auxiliary) await new Promise((done) => {
      const release = () => { clearTimeout(timer); held.delete(release); res.off("close", release); done() }
      const timer = setTimeout(release, 60_000)
      held.add(release)
      res.once("close", release)
    })
    res.end([
      `data: ${JSON.stringify({ id: "managed-fixture", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n")
  } catch { if (!res.headersSent) res.writeHead(400); res.end() }
})
await new Promise((done, reject) => server.listen(0, "127.0.0.1", done).once("error", reject))
const baseURL = `http://127.0.0.1:${server.address().port}`
const provider = (id) => ({
  name: `Managed fixture ${id}`,
  package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: `${baseURL}/v1`, apiKey: "fake-loopback-only" },
  models: { [id]: { name: id, modelID: id, variants: [{ id: "deliberate", headers: { "x-qm-fixture-variant": "deliberate" } }] } },
})
const routingProof = process.argv.includes("--routing-proof")
const initial = `${providers.initial}/composer`, selected = `${providers.selected}/selected`
const primary = { mode: "primary", model: initial, system: "Answer OK. Do not call tools." }
await writeFile(join(directory, "opencode.json"), JSON.stringify({
  "$schema": "https://opencode.ai/config.json",
  model: initial,
  default_agent: "qm-managed-test",
  agents: {
    build: primary,
    "qm-managed-test": primary,
    "qm-managed-unbound": primary,
    "qm-managed-spawner": { ...primary, system: "Use the subagent tool to run qm-managed-child, then answer OK." },
    "qm-managed-child": { ...primary, mode: "subagent", description: "Loopback routing proof only" },
    "qm-managed-broken": primary,
    "qm-managed-queued": primary,
    ...(routingProof ? { "qm-managed-recover": toolProof ? { ...primary, system: "Read the fixture's tool-proof.txt once, then answer OK." } : primary } : {}),
    title: { model: initial },
    summary: { model: initial },
    compaction: { model: initial },
  },
  providers: {
    [providers.initial]: provider("composer"),
    [providers.selected]: provider("selected"),
  },
  plugins: [{ package: pluginPackage, options: {
    plans: { admission: [selected], queued: [selected, initial], broken: [selected], ...(routingProof ? { recover: [selected, initial] } : {}) },
    agents: { build: "admission", "qm-managed-test": "admission", "qm-managed-child": "admission", "qm-managed-broken": "broken", "qm-managed-queued": "queued", ...(routingProof ? { "qm-managed-recover": "recover" } : {}) },
    exclusiveModels: [selected],
    localEndpoints: { [providers.selected]: `${baseURL}/health` },
    ...(routingProof ? { providerCooldownMs: 30_000 } : {}),
  } }],
}, null, 2))
console.log(JSON.stringify({ directory, pluginRoot, pluginPackage, providers, baseURL, traceURL: `${baseURL}/trace`, processID: process.pid }, null, 2))
console.log("Use this project in stock OpenChamber. Send qm-managed-auto; expect selected, never composer. No external provider is part of this fixture.")
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)))
// Keep artifacts for the managed session's history and later evidence inspection.
