import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const root = join(process.env.LOCALAPPDATA ?? "C:\\Users\\mattg\\AppData\\Local", "Temp", "opencode")
await mkdir(root, { recursive: true })
const temp = await mkdtemp(join(root, "qm-retry-"))
const project = join(temp, "project"), home = join(temp, "home"), requests = []
const exhausted = process.argv.includes("--exhausted")
const compaction = process.argv.includes("--compaction")
const probeCompactionSelection = process.argv.includes("--probe-compaction-selection")
const recoverCompaction = process.argv.includes("--recover-compaction")
const nextCompact = probeCompactionSelection || recoverCompaction
assert.ok(!recoverCompaction || compaction, "recovery check requires --compaction")
assert.ok(!probeCompactionSelection || compaction, "selection probe requires --compaction")
let warming = compaction
let previousIdle = -1
const failureMode = process.argv.find((arg) => arg.startsWith("--failure="))?.slice("--failure=".length) ?? "rate-limit"
const modes = new Set(["rate-limit", "internal", "transport", "auth", "quota", "missing-model", "context-overflow"])
assert.ok(exhausted || modes.has(failureMode), `unknown failure mode: ${failureMode}`)
await mkdir(project, { recursive: true })
await mkdir(home, { recursive: true })
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return res.writeHead(404).end()
  const body = JSON.parse(Buffer.concat(chunks).toString())
  requests.push({
    model: body.model,
    at: Date.now(),
    userMessages: body.messages.filter((message) => message.role === "user").map((message) => message.content),
    toolCalls: body.messages.flatMap((message) => message.tool_calls ?? []).length,
  })
  if (!warming && (body.model === "primary" || exhausted)) {
    if (!exhausted && failureMode === "transport") return req.socket.destroy()
    const failure = exhausted || failureMode === "rate-limit"
      ? { status: 429, headers: { "retry-after": "0" }, error: { message: "local retry", type: "rate_limit_error", code: "rate_limit_exceeded" } }
      : failureMode === "internal"
        ? { status: 503, headers: {}, error: { message: "local retry", type: "server_error", code: "server_error" } }
        : failureMode === "auth"
          ? { status: 401, headers: {}, error: { message: "local auth fixture", type: "authentication_error", code: "invalid_api_key" } }
          : failureMode === "quota"
            ? { status: 402, headers: {}, error: { message: "local quota fixture", type: "insufficient_quota", code: "insufficient_quota" } }
            : failureMode === "missing-model"
              ? { status: 404, headers: {}, error: { message: "local missing-model fixture", type: "invalid_request_error", code: "model_not_found" } }
              : { status: 413, headers: {}, error: { message: "local context fixture", type: "invalid_request_error", code: "context_length_exceeded" } }
    res.writeHead(failure.status, { "content-type": "application/json", ...failure.headers })
    return res.end(JSON.stringify({ error: failure.error }))
  }
  res.writeHead(200, { "content-type": "text/event-stream" })
  const content = nextCompact && !warming
    ? "## Objective\n- Reply OK.\n\n## Requirements\n- (none)\n\n## Decisions\n- (none)\n\n## Work State\n### Completed\n- Replied OK.\n### Active\n- (none)\n### Blocked\n- (none)\n\n## Next Move\n1. Await user input.\n\n## Relevant Files\n- (none)\n\n## Important Context\n- Local fixture only."
    : "OK"
  res.end([
    `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "data: [DONE]",
  ].join("\n\n") + "\n\n")
})

await new Promise((resolveListen, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", resolveListen)
})
const config = {
  "$schema": "https://opencode.ai/config.json", model: "local/primary",
  agents: { "retry-check": { mode: "primary", model: "local/primary", system: "Answer with one word." } },
  providers: { local: {
    name: "Local retry test", package: "@opencode/ai/providers/openai-compatible", env: ["QM_LOCAL_API_KEY"],
    settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1` },
    models: { primary: { name: "Primary", modelID: "primary" } },
  }, backup: {
    name: "Local backup test", package: "@opencode/ai/providers/openai-compatible", env: ["QM_LOCAL_API_KEY"],
    settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1` },
    models: { fallback: { name: "Fallback", modelID: "fallback" } },
  } },
   plugins: [{ package: resolve(".") }, join(project, "observer")],
}
await writeFile(join(project, "opencode.json"), JSON.stringify(config, null, 2))
await writeFile(join(project, "quartermaster.jsonc"), JSON.stringify({
  plans: { "retry-test": ["local/primary", "backup/fallback"] },
  agents: { "retry-check": "retry-test" },
}))
await mkdir(join(project, "observer"))
await writeFile(join(project, "observer", "index.ts"), `
import { Plugin } from "@opencode/plugin"
export default Plugin.define({ id: "qm-contract-observer", async setup(ctx) {
  const controller = new AbortController()
  const selectionProbe = ${probeCompactionSelection} ? await ctx.session.hook("compaction", async e => {
    await ctx.session.switchModel({ sessionID: e.sessionID, model: { providerID: "backup", id: "fallback" } })
    console.warn("QM_CONTRACT " + JSON.stringify({ source: "compaction-selection-probe", capturedModel: e.model.id }))
  }) : undefined
  const requestHook = await ctx.session.hook("model.request", e => {
    console.warn("QM_CONTRACT " + JSON.stringify({ source: "model.request", kind: e.kind }))
  })
  const hook = await ctx.session.hook("retry", e => {
    console.warn("QM_CONTRACT " + JSON.stringify({ source: "retry",
      type: e.error.type, status: e.error.status, retry: e.decision.retry }))
  })
  const task = (async () => {
    for await (const e of ctx.event.subscribe({}, { signal: controller.signal })) {
       if (e.type === "session.execution.failed" || e.type === "session.step.failed" || e.type === "session.compaction.failed")
         console.warn("QM_CONTRACT " + JSON.stringify({ source: e.type,
           type: e.data.error?.type, status: e.data.error?.status,
           ...(${probeCompactionSelection} && e.type === "session.compaction.failed" ? { fixtureError: e.data.error?.message } : {}) }))
    }
  })().catch(() => {})
  return async () => { controller.abort(); await selectionProbe?.dispose(); await hook.dispose(); await requestHook.dispose(); await task }
}})
`)
const env = Object.fromEntries(Object.entries({
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ComSpec: process.env.ComSpec,
  TEMP: home, TMP: home, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"), XDG_CONFIG_HOME: join(home, ".config"), QM_LOCAL_API_KEY: "fake-only",
  OPENCODE_SERVER_PASSWORD: "isolated-fixture-only",
}).filter(([, value]) => value !== undefined))
let stdout = "", stderr = ""
let passed = false
let child
const listener = createServer()
await new Promise(resolveListen => listener.listen(0, "127.0.0.1", resolveListen))
const port = listener.address().port
await new Promise(resolveClose => listener.close(resolveClose))
const location = `location%5Bdirectory%5D=${encodeURIComponent(project)}`
async function api(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}${path.includes("?") ? "&" : "?"}${location}`, {
    method, headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from("opencode:isolated-fixture-only").toString("base64")}` },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  assert.ok(response.ok, `${response.status}: ${text}`)
  return text ? JSON.parse(text) : undefined
}
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
try {
  const executable = join(homedir(), ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode")
  const version = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true })
  assert.equal(version.status, 0, version.stderr)
   assert.match(version.stdout, /2\.0\.31/, `expected OpenCode 2.0.31, got ${version.stdout.trim()}`)
  child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
    cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", chunk => { stdout += chunk })
  child.stderr.on("data", chunk => { stderr += chunk })
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { await api("GET", "/api/agent"); ready = true; break } catch {}
    await delay(200)
  }
  assert.ok(ready, "isolated serving process must become ready")
  const created = await api("POST", "/api/session", {})
  const sessionID = created.id ?? created.data?.id
  await api("POST", `/api/session/${sessionID}/agent`, { agent: "retry-check" })
  await api("POST", `/api/session/${sessionID}/model`, { model: { providerID: "local", id: "primary" } })
  const diagnostic = await api("POST", "/api/rpc/quartermaster/diagnoseSession", { input: { sessionID } })
  assert.match(JSON.stringify(diagnostic), /retry-test/, "fixture must load the bound Quartermaster plan")
   if (compaction) {
     await api("POST", `/api/session/${sessionID}/prompt`, { text: "Reply with exactly OK." })
     let seeded = false
     for (let i = 0; i < 150; i++) {
       const response = await api("GET", `/api/session/${sessionID}`)
       const info = response.data ?? response
       if (info.outcome === "succeeded" && info.time?.idle !== undefined) { previousIdle = info.time.idle; seeded = true; break }
       await delay(200)
     }
     assert.ok(seeded, "compaction fixture must seed a completed conversation")
     requests.length = 0
     warming = false
     await api("POST", `/api/session/${sessionID}/compact`, {})
   } else {
     await api("POST", `/api/session/${sessionID}/prompt`, { text: "Reply with exactly OK." })
   }
  let outcome
  for (let i = 0; i < 900; i++) {
    const response = await api("GET", `/api/session/${sessionID}`)
    const info = response.data ?? response
     if (info.outcome && info.time?.idle !== undefined && info.time.idle > previousIdle) { outcome = info.outcome; break }
    await delay(200)
  }
  assert.ok(outcome, "isolated execution must reach a terminal outcome")
   const code = outcome === "succeeded" ? 0 : 1
   if (compaction) {
     assert.ok(requests.length > 0, "compaction must dispatch a provider request")
     await delay(500)
     assert.ok((stdout + stderr).includes('"source":"session.compaction.failed"'), "host must deliver the compaction failure independently of execution outcome")
     console.log(`Compaction contract: ${requests.map(({ model }) => model).join(" -> ")}; outcome ${outcome}.`)
      console.log((stdout + "\n" + stderr).split(/\r?\n/).filter(line => line.includes("QM_CONTRACT")).join("\n"))
      if (failureMode === "quota" || failureMode === "rate-limit") {
        const evidence = await api("POST", "/api/rpc/quartermaster/diagnoseSession", { input: { sessionID } })
        assert.match(JSON.stringify(evidence), /"failureCooldowns":\[\{[^}]*"modelID":"primary"[^}]*"until":\d+/, "compaction must persist model failure evidence")
         const before = requests.length
          if (nextCompact) {
           assert.ok(requests.every(({ model }) => model === "primary"), "switching inside compaction must not change the already captured provider request")
           const state = await api("GET", `/api/session/${sessionID}`)
           const info = state.data ?? state
           assert.equal(info.model.id, "fallback", "probe must demonstrate the persistent session model side effect")
           previousIdle = info.time.idle
           await api("POST", `/api/session/${sessionID}/compact`, {})
         } else {
           await api("POST", `/api/session/${sessionID}/prompt`, { text: "Reply with exactly OK." })
         }
        let recovered = false
        for (let i = 0; i < 150; i++) {
          const response = await api("GET", `/api/session/${sessionID}`)
          const info = response.data ?? response
            if (info.outcome === "succeeded" && requests.length > before && (!nextCompact || info.time?.idle > previousIdle)) { recovered = true; break }
          await delay(200)
        }
        assert.ok(recovered, "explicit next prompt must recover after compaction failure")
         assert.ok(requests.slice(before).every(({ model }) => model === "fallback"), "actual next dispatch must skip the failed compaction model")
          if (nextCompact) {
           const messages = await api("GET", `/api/session/${sessionID}/message?limit=1&order=desc&type=compaction`)
           assert.equal(messages.data[0].status, "completed", "second compact must complete native compaction, not merely change the UI model")
            console.log(probeCompactionSelection ? "Selection probe: current compact model is captured before the hook." : "QM recovery: next compact completes on fallback without a prompt or observer switch.")
         }
      }
    } else {
  if (exhausted) {
    const models = requests.map(({ model }) => model)
    assert.equal(code, 1, `the exhausted fallback should report a failed run. stdout:\n${stdout}\nstderr:\n${stderr}`)
    assert.deepEqual(models, ["primary", "primary", ...Array(10).fill("fallback")], "the host retry ceiling must bound attempts across primary and fallback models")
    assert.deepEqual(requests.map(({ userMessages }) => userMessages), Array(12).fill(requests[0].userMessages), "exhaustion must remain in the original prompt")
    assert.deepEqual(requests.map(({ toolCalls }) => toolCalls), Array(12).fill(0), "the exhausted prompt must not add tool calls")
    console.log(`Exhausted retry trace: ${requests.map(({ model }) => model).join(" -> ")}; exit ${code}.`)
  } else if (["rate-limit", "internal", "transport"].includes(failureMode)) {
    assert.equal(code, 0, `OpenCode failed. stdout:\n${stdout}\nstderr:\n${stderr}`)
    const models = requests.map(({ model }) => model)
    assert.equal(models.at(-1), "fallback", "safe native retries must eventually reach fallback")
    assert.ok(models.filter((model) => model === "primary").length >= 2, "host must retry primary natively")
    assert.ok(models.length <= 12, "host retry ceiling must bound attempts across both models")
    assert.deepEqual(requests.map(({ userMessages }) => userMessages), Array(requests.length).fill(requests[0].userMessages), "native retries must not submit a second prompt")
    assert.deepEqual(requests.map(({ toolCalls }) => toolCalls), Array(requests.length).fill(0), "the prompt must not add tool calls")
    assert.equal(outcome, "succeeded", "the same prompt must complete on the fallback")
    if (failureMode === "rate-limit") {
      assert.deepEqual(models, ["primary", "primary", "fallback"], "the established rate-limit trace must remain stable")
      assert.ok(requests[2].at - requests[1].at >= 1_000, `OpenCode's native retry delay must remain in effect (observed ${requests[2].at - requests[1].at}ms)`)
    }
  } else {
    assert.notEqual(code, 0, `terminal ${failureMode} should fail without fallback. stdout:\n${stdout}\nstderr:\n${stderr}`)
    const models = requests.map(({ model }) => model)
    assert.ok(models.length > 0 && models.every((model) => model === "primary"), `${failureMode} must not trigger a model switch`)
     assert.ok(models.length <= 11, "native host attempts remain bounded")
   }
   }
     if (failureMode === "quota" && !exhausted) {
      // Restart only this isolated fixture, retaining its storage and session.
      const closed = new Promise(resolveClose => child.once("close", resolveClose))
      if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
      else child.kill("SIGTERM")
      await closed
      child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
        cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      })
      child.stdout.on("data", chunk => { stdout += chunk })
      child.stderr.on("data", chunk => { stderr += chunk })
      let restarted = false
      for (let i = 0; i < 100; i++) {
        try { await api("GET", "/api/agent"); restarted = true; break } catch {}
        await delay(200)
      }
      assert.ok(restarted, "isolated fixture must restart with retained storage")
      const before = requests.length
     await api("POST", `/api/session/${sessionID}/prompt`, { text: "Reply with exactly OK." })
     let recovered = false
     for (let i = 0; i < 150; i++) {
       const response = await api("GET", `/api/session/${sessionID}`)
       const info = response.data ?? response
       if (info.outcome === "succeeded" && requests.length > before) { recovered = true; break }
       await delay(200)
     }
     assert.ok(recovered, "next explicit prompt must recover from retained quota evidence")
     assert.ok(requests.slice(before).length > 0 && requests.slice(before).every(({ model }) => model === "fallback"), "quota cooldown must prevent dispatch to primary on the next prompt (including title generation)")
   }
   const observations = (stdout + "\n" + stderr).split(/\r?\n/).filter(line => line.includes("QM_CONTRACT"))
   assert.ok(observations.length > 0, "fixture observer must supply error-contract evidence")
   console.log(observations.join("\n"))
   passed = true
   if (!exhausted) console.log(`Quartermaster retry contract passed (${failureMode}): ${requests.map(({ model }) => model).join(" -> ")}.`)
} finally {
  if (child?.pid && child.exitCode === null) {
    const closed = new Promise(resolveClose => child.once("close", resolveClose))
    if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    else child.kill("SIGTERM")
    await closed
  }
  await new Promise((resolveClose) => server.close(resolveClose))
  if (passed) await rm(temp, { recursive: true, force: true })
  else console.error(`Harness artifacts retained for diagnosis: ${temp}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
}
