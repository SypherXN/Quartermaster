import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createServer as createTcpServer } from "node:net"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const root = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local", "Temp"), "opencode")
await mkdir(root, { recursive: true })
const temp = await mkdtemp(join(root, "qm-admission-"))
const project = join(temp, "project"), home = join(temp, "home"), requests = []
let healthAvailable = true
let healthProbes = 0
const password = "qm-admission-fixture"
const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
const fake = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    healthProbes++
    return res.writeHead(healthAvailable ? 200 : 503).end()
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return res.writeHead(404).end()
  const body = JSON.parse(Buffer.concat(chunks).toString())
  requests.push({
    model: body.model,
    path: req.url,
    stream: body.stream,
    messages: body.messages.map((message) => ({
      role: message.role,
      content: typeof message.content === "string" ? message.content : undefined,
      toolCalls: message.tool_calls?.length ?? 0,
    })),
    tools: body.tools?.map((tool) => tool.function?.name ?? tool.name) ?? [],
  })
  res.writeHead(200, { "content-type": "text/event-stream" })
  res.end([
    `data: ${JSON.stringify({ id: "admission", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: "admission", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "data: [DONE]",
  ].join("\n\n") + "\n\n")
})
await new Promise((resolveListen, reject) => {
  fake.once("error", reject)
  fake.listen(0, "127.0.0.1", resolveListen)
})
const probe = createTcpServer()
await new Promise((resolveListen, reject) => probe.listen(0, "127.0.0.1", resolveListen).once("error", reject))
const port = probe.address().port
await new Promise((resolveClose) => probe.close(resolveClose))
await mkdir(project, { recursive: true })
await mkdir(home, { recursive: true })
const config = {
  "$schema": "https://opencode.ai/config.json",
  model: "initial/composer",
  agents: {
    "qm-test": { mode: "primary", model: "initial/composer", system: "Answer briefly." },
    "qm-unbound": { mode: "primary", model: "initial/composer", system: "Answer briefly." },
  },
  providers: {
    initial: { name: "Initial fixture", package: "@opencode/ai/providers/openai-compatible", env: ["QM_LOCAL_API_KEY"], settings: { baseURL: `http://127.0.0.1:${fake.address().port}/v1` }, models: { composer: { name: "Initial", modelID: "composer" } } },
    qm: { name: "Quartermaster fixture", package: "@opencode/ai/providers/openai-compatible", env: ["QM_LOCAL_API_KEY"], settings: { baseURL: `http://127.0.0.1:${fake.address().port}/v1` }, models: { selected: { name: "Selected", modelID: "selected" } } },
  },
  plugins: [{ package: process.argv[2] ? resolve(process.argv[2]) : resolve("."), options: {
    plans: { admission: ["qm/selected"] }, agents: { "qm-test": "admission" },
    localEndpoints: { qm: `http://127.0.0.1:${fake.address().port}/health` },
  } }],
}
await writeFile(join(project, "opencode.json"), JSON.stringify(config, null, 2))
const env = Object.fromEntries(Object.entries({
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ComSpec: process.env.ComSpec,
  TEMP: home, TMP: home, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"), XDG_CONFIG_HOME: join(home, ".config"),
  QM_LOCAL_API_KEY: "fake-only", OPENCODE_SERVER_PASSWORD: password,
}).filter(([, value]) => value !== undefined))
const executable = process.argv[3] ?? join(homedir(), ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode")
const version = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true })
assert.equal(version.status, 0, version.stderr)
const hostVersion = version.stdout.trim().replace(/^opencode v/, "")
assert.match(hostVersion, /^2\.0\.(?:25|26|27)$/, `expected OpenCode 2.0.25, 2.0.26 or 2.0.27, got ${hostVersion}`)
let output = "", passed = false
const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
  cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
})
child.stdout.on("data", (chunk) => { output += chunk })
child.stderr.on("data", (chunk) => { output += chunk })
const stop = async () => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise((resolveClose) => child.once("close", resolveClose))
  if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
  else child.kill("SIGTERM")
  await closed
}
async function api(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { authorization: auth, "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, text: await response.text() }
}
async function ready() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const result = await api("GET", "/api/agent")
      if (result.status === 200) return
    } catch {}
    await delay(250)
  }
  throw new Error(`OpenCode API did not become ready: ${output.slice(-3000)}`)
}
async function sessionWithDefault(agent = "qm-test") {
  const created = await api("POST", "/api/session", {})
  assert.equal(created.status, 200, created.text)
  const data = JSON.parse(created.text)
  const sessionID = data.id ?? data.data?.id
  assert.ok(sessionID, created.text)
  assert.equal((await api("POST", `/api/session/${sessionID}/agent`, { agent })).status, 204)
  assert.equal((await api("POST", `/api/session/${sessionID}/model`, { model: { providerID: "initial", id: "composer" } })).status, 204)
  return sessionID
}
const hasUserText = (request, text) => request.messages.findLast((message) => message.role === "user")?.content === text
const isTitleRequest = (request) => request.messages.some((message) => message.role === "system" && String(message.content).includes("You are a title generator"))

async function waitForPrimaryRequest(text) {
  const primary = (request) => hasUserText(request, text) && !isTitleRequest(request)
  for (let i = 0; i < 100 && !requests.some(primary); i += 1) await delay(100)
  return requests.filter(primary)
}

async function waitForCompletion(sessionID) {
  for (let i = 0; i < 100; i++) {
    const result = await api("GET", `/api/session/${sessionID}`)
    assert.equal(result.status, 200, result.text)
    const response = JSON.parse(result.text), info = response.data ?? response
    if (info.outcome === "succeeded" && info.time.idle !== undefined) return
    await delay(100)
  }
  throw new Error(`Fixture session ${sessionID} did not finish`)
}

try {
  await ready()
  const diagnostic = await sessionWithDefault()
  const beforeStatus = JSON.parse((await api("GET", `/api/session/${diagnostic}`)).text)
  const beforeRequests = requests.length, beforeProbes = healthProbes
  const statusCommand = await api("POST", `/api/session/${diagnostic}/command`, { name: "qm-status", text: "" })
  assert.equal(statusCommand.status, 204, statusCommand.text)
  const inbox = await api("GET", `/api/session/${diagnostic}/inbox`)
  assert.equal(inbox.status, 200, inbox.text)
  const statusMessage = JSON.parse(inbox.text).data.find((item) => item.type === "synthetic" && item.payload.description?.startsWith("Quartermaster routing diagnostics"))
  assert.ok(statusMessage, `qm-status must queue its diagnostic without waking execution: ${inbox.text}`)
  assert.equal(statusMessage.delivery, "queue")
  const report = JSON.parse(statusMessage.payload.text)
  assert.equal(report.runtime.host.version, hostVersion)
  assert.equal(report.runtime.processID, child.pid)
  assert.equal(report.session.mode, "automatic")
  assert.equal(report.session.model.modelID, "composer")
  assert.equal(report.recommendation.status, "no-eligible", JSON.stringify(report))
  assert.equal(report.recommendation.skipped[0].code, "not-in-registry", "startup diagnostics must honestly retain the pre-provider cached catalog")
  assert.equal(report.primaryRequestEvidence.lastObserved, "unknown")
  const immediate = await api("POST", "/api/rpc/quartermaster/diagnoseSession", { input: { sessionID: diagnostic } })
  assert.equal(immediate.status, 200, immediate.text)
  const rpcReport = JSON.parse(immediate.text).output
  assert.equal(rpcReport.runtime.pluginInstanceID, report.runtime.pluginInstanceID)
  assert.equal(rpcReport.session.scope, "confirmed-project")
  assert.equal(rpcReport.session.model.modelID, "composer")
  assert.deepEqual(rpcReport.recommendation, report.recommendation)
  assert.deepEqual(JSON.parse((await api("GET", `/api/session/${diagnostic}/inbox`)).text).data, JSON.parse(inbox.text).data, "RPC must not enqueue output")
  await delay(300)
  assert.equal(requests.length, beforeRequests, "qm-status must not resume execution or send auxiliary/primary requests")
  assert.equal(healthProbes, beforeProbes, "qm-status must not probe health")
  const afterStatus = JSON.parse((await api("GET", `/api/session/${diagnostic}`)).text)
  assert.deepEqual((afterStatus.data ?? afterStatus).model, (beforeStatus.data ?? beforeStatus).model, "qm-status must not switch the host model")
  const automatic = await sessionWithDefault()
  const automaticText = `automatic-${automatic}`
  assert.equal((await api("POST", `/api/session/${automatic}/prompt`, { text: automaticText })).status, 200)
  assert.deepEqual((await waitForPrimaryRequest(automaticText)).map((request) => request.model), ["selected"], "first primary call must use QM's model, never the displaced default")
  const afterAdmissionRequests = requests.length, afterAdmissionProbes = healthProbes
  const refreshedDiagnostic = await api("POST", "/api/rpc/quartermaster/diagnoseSession", { input: { sessionID: diagnostic } })
  assert.equal(refreshedDiagnostic.status, 200, refreshedDiagnostic.text)
  assert.equal(JSON.parse(refreshedDiagnostic.text).output.recommendation.selected.modelID, "selected", "normal admission refreshes the cached catalog, not diagnostics")
  assert.equal(requests.length, afterAdmissionRequests)
  assert.equal(healthProbes, afterAdmissionProbes)

  await waitForCompletion(automatic)
  assert.equal((await api("POST", `/api/session/${automatic}/model`, { model: { providerID: "initial", id: "composer" } })).status, 204)
  const laterText = `later-${automatic}`
  assert.equal((await api("POST", `/api/session/${automatic}/prompt`, { text: laterText })).status, 200)
  assert.deepEqual((await waitForPrimaryRequest(laterText)).map((request) => request.model), ["selected"], "an existing idle bound session must route again, not retain a reasserted host default")
  await waitForCompletion(automatic)

  const forked = await api("POST", `/api/session/${automatic}/fork`, {})
  assert.equal(forked.status, 200, forked.text)
  const forkedData = JSON.parse(forked.text)
  const childSessionID = forkedData.id ?? forkedData.data?.id
  assert.ok(childSessionID, forked.text)
  assert.equal((await api("POST", `/api/session/${childSessionID}/agent`, { agent: "qm-test" })).status, 204)
  assert.equal((await api("POST", `/api/session/${childSessionID}/model`, { model: { providerID: "initial", id: "composer" } })).status, 204)
  const childText = `child-${childSessionID}`
  assert.equal((await api("POST", `/api/session/${childSessionID}/prompt`, { text: childText })).status, 200)
  assert.deepEqual((await waitForPrimaryRequest(childText)).map((request) => request.model), ["selected"], "bound child session must route before its first primary request")

  const manual = await sessionWithDefault()
  assert.equal((await api("POST", `/api/session/${manual}/command`, { name: "qm-manual", text: "" })).status, 204)
  const manualText = `manual-${manual}`
  assert.equal((await api("POST", `/api/session/${manual}/prompt`, { text: manualText })).status, 200)
  assert.deepEqual((await waitForPrimaryRequest(manualText)).map((request) => request.model), ["composer"], "manual ownership must preserve the host-selected model")
  await waitForCompletion(manual)
  assert.equal((await api("POST", `/api/session/${manual}/command`, { name: "qm-auto", text: "" })).status, 204)
  const resumedText = `resumed-${manual}`
  assert.equal((await api("POST", `/api/session/${manual}/prompt`, { text: resumedText })).status, 200)
  assert.deepEqual((await waitForPrimaryRequest(resumedText)).map((request) => request.model), ["selected"], "resuming automatic routing replaces the previous manual default before sending")

  const unbound = await sessionWithDefault("qm-unbound")
  const unboundText = `unbound-${unbound}`
  assert.equal((await api("POST", `/api/session/${unbound}/prompt`, { text: unboundText })).status, 200)
  assert.deepEqual((await waitForPrimaryRequest(unboundText)).map((request) => request.model), ["composer"], "unbound agents retain their host model")

  await waitForCompletion(unbound)
  assert.equal((await api("POST", `/api/session/${unbound}/command`, { name: "qm-manual", text: "" })).status, 204)
  assert.equal((await api("POST", `/api/session/${unbound}/agent`, { agent: "qm-test" })).status, 204)
  const changedAgentText = `changed-agent-${unbound}`
  assert.equal((await api("POST", `/api/session/${unbound}/prompt`, { text: changedAgentText })).status, 200)
  assert.deepEqual((await waitForPrimaryRequest(changedAgentText)).map((request) => request.model), ["selected"], "manual ownership for an unbound agent must not leak into a newly bound agent")

  await delay(5100)
  healthAvailable = false
  const unavailable = await sessionWithDefault()
  const unavailableText = `unavailable-${unavailable}`
  const rejected = await api("POST", `/api/session/${unavailable}/prompt`, { text: unavailableText })
  assert.notEqual(rejected.status, 200, `automatic admission with no eligible candidate must be rejected: ${rejected.text}`)
  await delay(300)
  assert.deepEqual(
    requests.filter((request) => hasUserText(request, unavailableText) && !isTitleRequest(request)).map((request) => request.model),
    [],
    "rejected automatic admission must not send the displaced default or any primary request",
  )

  passed = true
  const automaticPrimary = requests.filter((request) => hasUserText(request, automaticText) && !isTitleRequest(request)).map((request) => request.model)
  const manualPrimary = requests.filter((request) => hasUserText(request, manualText) && !isTitleRequest(request)).map((request) => request.model)
  console.log(`Admission trace passed on OpenCode ${hostVersion}: qm-status=no-inference/no-switch; automatic=${automaticPrimary.join(",")}; later-idle=selected; child=selected; manual=${manualPrimary.join(",")}; resumed=selected; unbound=composer; changed-agent=selected; unavailable=rejected/no-primary-request.`)
} finally {
  await stop()
  await new Promise((resolveClose) => fake.close(resolveClose))
  if (passed) await rm(temp, { recursive: true, force: true })
  else console.error(`Fixture artifacts retained: ${temp}\nrequests=${JSON.stringify(requests)}\n${output.slice(-5000)}`)
}
