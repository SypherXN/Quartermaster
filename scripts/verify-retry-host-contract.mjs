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
  if (body.model === "primary" || exhausted) {
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
  res.end([
    `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}`,
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
  plugins: [{ package: resolve("."), options: {
    plans: { "retry-test": ["local/primary", "backup/fallback"] },
    agents: { "retry-check": "retry-test" },
  } }],
}
await writeFile(join(project, "opencode.json"), JSON.stringify(config, null, 2))
const env = Object.fromEntries(Object.entries({
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ComSpec: process.env.ComSpec,
  TEMP: home, TMP: home, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"), XDG_CONFIG_HOME: join(home, ".config"), QM_LOCAL_API_KEY: "fake-only",
}).filter(([, value]) => value !== undefined))
let stdout = "", stderr = ""
let passed = false
try {
  const executable = join(homedir(), ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode")
  const version = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true })
  assert.equal(version.status, 0, version.stderr)
  assert.match(version.stdout, /2\.0\.24/, `expected OpenCode 2.0.24, got ${version.stdout.trim()}`)
  const child = spawn(executable, ["run", "--standalone", "--print-logs", "--log-level", "debug", "--agent", "retry-check", "--model", "local/primary", "Reply with exactly OK."], {
    cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  })
  const code = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      if (child.pid && process.platform === "win32") spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
      else child.kill("SIGKILL")
      reject(new Error("OpenCode local host check timed out"))
    }, 180_000)
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("close", (exitCode) => { clearTimeout(timer); resolveExit(exitCode) })
  })
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
    assert.match(stdout, /OK/, "the same prompt must complete on the fallback")
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
  passed = true
  if (!exhausted) console.log(`Quartermaster retry contract passed (${failureMode}): ${requests.map(({ model }) => model).join(" -> ")}.`)
} finally {
  await new Promise((resolveClose) => server.close(resolveClose))
  if (passed) await rm(temp, { recursive: true, force: true })
  else console.error(`Harness artifacts retained for diagnosis: ${temp}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
}
