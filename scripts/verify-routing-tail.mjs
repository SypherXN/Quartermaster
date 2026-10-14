import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

// Existing authenticated managed host only; providers and files are disposable loopback fixtures.
const host = process.env.OPENCODE_PERMISSION_REVIEWER_HOST_URL
assert.match(host ?? "", /^http:\/\/127\.0\.0\.1:\d+$/)
const pluginArg = process.argv.find((arg) => arg.startsWith("--plugin-root="))
const exe = process.argv.find((arg) => arg.startsWith("--executable="))?.slice(13) ?? join(homedir(), ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode")
const child = spawn(process.execPath, ["scripts/prepare-managed-host-fixture.mjs", "--routing-proof", "--tool-proof", ...(pluginArg ? [pluginArg] : [])], {
  windowsHide: true, stdio: ["ignore", "pipe", "inherit"],
})
let fixture
const proof = { host, passed: false, sessions: [], cleanup: false }
const api = (method, path, body) => new Promise((resolve, reject) => {
  const args = ["api", "--server", host, method, `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({ "location[directory]": fixture.directory })}`]
  if (body !== undefined) args.push("--data", JSON.stringify(body))
  const call = spawn(exe, args, { windowsHide: true })
  let stdout = "", stderr = ""
  const timer = setTimeout(() => { call.kill(); reject(Error("CLI timeout")) }, 60_000)
  call.once("error", (error) => { clearTimeout(timer); reject(error) })
  call.stdout.on("data", (chunk) => { stdout += chunk })
  call.stderr.on("data", (chunk) => { stderr += chunk })
  call.once("close", (status) => {
    clearTimeout(timer)
    try { assert.equal(status, 0, stderr || stdout); resolve(stdout.trim() ? JSON.parse(stdout) : null) }
    catch (error) { reject(error) }
  })
})
const trace = () => fetch(fixture.traceURL, { signal: AbortSignal.timeout(5_000) }).then((r) => r.json())
const control = async (path, body) => {
  const response = await fetch(fixture.baseURL + path, { method: "POST", signal: AbortSignal.timeout(5_000),
    headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  assert.equal(response.status, 204)
}
const messages = async (id) => (await api("get", `/api/session/${id}/message?limit=100&order=asc`)).data
const until = async (read, check, label) => {
  for (let i = 0; i < 80; i++) { const value = await read(); if (check(value)) return value; await delay(250) }
  throw Error(`Timed out: ${label}`)
}
const open = async (title) => {
  const created = await api("post", "/api/session", { title, location: { directory: fixture.directory } })
  const id = (created.data ?? created).id
  proof.sessions.push(id)
  await api("post", `/api/session/${id}/agent`, { agent: "qm-managed-recover" })
  await api("post", `/api/session/${id}/model`, { model: { providerID: fixture.providers.initial, id: "composer" } })
  return id
}
const send = async (id, marker, expected) => {
  const before = (await messages(id)).length
  const start = (await trace()).requests.length
  await api("post", `/api/session/${id}/prompt`, { text: marker, delivery: "queue", resume: true })
  const history = await until(() => messages(id), (rows) => rows.length > before && rows.at(-1)?.type === "idle", marker)
  assert.equal(history.at(-1).outcome, "succeeded")
  const requests = (await trace()).requests.slice(start).filter((row) => !row.auxiliary)
  assert.deepEqual(requests.map((row) => [row.model, row.variant]), expected)
  const session = (await api("get", `/api/session/${id}`)).data
  assert.equal(session.model.id, expected.at(-1)[0])
  return { marker, requests, history, session }
}
try {
  fixture = await new Promise((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => reject(Error("Fixture startup timeout")), 5_000)
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("exit", () => { clearTimeout(timer); reject(Error("Fixture exited before startup")) })
    child.stdout.on("data", (chunk) => {
      output += chunk
      const end = output.indexOf("\n}")
      if (end !== -1) { clearTimeout(timer); resolve(JSON.parse(output.slice(0, end + 2))) }
    })
  })
  proof.fixture = fixture
  if (pluginArg) {
    assert.equal(fixture.pluginRoot, resolve(pluginArg.slice(14)))
    proof.package = JSON.parse(await readFile(join(fixture.pluginRoot, "package.json"), "utf8"))
    assert.equal(proof.package.name, "opencode-quartermaster")
  }
  proof.info = await api("get", "/api/info")
  assert.match(proof.info.version, /^2\./)
  assert.ok(proof.info.urls.includes(host))
  proof.reviewer = (await api("post", "/api/rpc/opencode-permission-reviewer/status", { input: {} })).output.variant
  const id = await open("QM automatic tool/partial continuation")
  const start = (await trace()).requests.length
  await control("/failure", { mode: "partial-after-tool", remaining: 1, model: "selected" })
  await api("post", `/api/session/${id}/prompt`, { text: "qm-managed-tool-once", delivery: "queue", resume: true })
  const history = await until(() => messages(id), (rows) => rows.some((m) => m.type === "idle"), "automatic partial completion")
  const requests = (await trace()).requests.slice(start).filter((row) => !row.auxiliary)
  const tools = history.filter((m) => m.type === "assistant").flatMap((m) => m.content ?? []).filter((part) => part.type === "tool")
  const diagnostic = (await api("post", "/api/rpc/quartermaster/diagnoseSession", { input: { sessionID: id } })).output
  proof.partial = { id, label: "automatic partial-output continuation, not fallback", requests, tools, history, diagnostic }
  assert.equal(diagnostic.session.mode, "automatic")
  assert.equal(diagnostic.runtime.processID, proof.info.pid)
  assert.equal(resolve(diagnostic.location.directory), resolve(fixture.directory))
  if (proof.package) assert.equal(diagnostic.plugin.version, proof.package.version)
  assert.ok(requests.length >= 3 && requests.length <= 12)
  assert.ok(requests.every((row) => row.model === "selected" && row.variant === null), "partial output must never switch to backup")
  assert.equal(requests.filter((row) => row.emitRead).length, 1)
  assert.equal(requests.filter((row) => row.failure === "partial-after-tool").length, 1)
  assert.ok(requests.some((row) => row.marker === null && row.failure === null), "include marker-less continuation")
  assert.equal(tools.length, 1, "the completed tool must not be replayed")
  assert.equal(tools[0].name, "read")
  assert.equal(tools[0].state.status, "completed")
  assert.equal(tools[0].state.input.path ?? tools[0].state.input.filePath, join(fixture.directory, "tool-proof.txt"))
  assert.ok(tools[0].time.ran <= tools[0].time.completed)
  assert.ok(tools[0].state.content.some((part) => part.type === "text" && part.text.includes("QM read-once proof")))
  assert.ok(history.some((m) => m.type === "assistant" && (m.content ?? []).some((part) => part.type === "text" && part.text.includes("PARTIAL"))))
  assert.equal(history.findLast((m) => m.type === "idle").outcome, "succeeded")
  await control("/failure", { mode: "none", remaining: 0 })
  const controlsID = await open("QM routing controls")
  proof.controls = { id: controlsID, sends: [] }
  proof.controls.sends.push(await send(controlsID, "qm-managed-admission", [["selected", null]]))
  proof.controls.sends.push(await send(controlsID, "qm-managed-repeat", [["selected", null]]))
  await api("post", `/api/session/${controlsID}/command`, { name: "qm-manual", text: "" })
  await api("post", `/api/session/${controlsID}/model`, { model: { providerID: fixture.providers.initial, id: "composer", variant: "deliberate" } })
  proof.controls.sends.push(await send(controlsID, "qm-managed-manual", [["composer", "deliberate"]]))
  proof.controls.sends.push(await send(controlsID, "qm-managed-manual-repeat", [["composer", "deliberate"]]))
  await api("post", `/api/session/${controlsID}/command`, { name: "qm-auto", text: "" })
  proof.controls.sends.push(await send(controlsID, "qm-managed-resume", [["selected", null]]))
  const exhaustedID = await open("QM bounded exhaustion")
  const exhaustStart = (await trace()).requests.length
  await control("/failure", { mode: "rate-limit", remaining: 40, model: null })
  await api("post", `/api/session/${exhaustedID}/prompt`, { text: "qm-managed-exhaust", delivery: "queue", resume: true })
  const exhaustedHistory = await until(() => messages(exhaustedID), (rows) => rows.some((m) => m.type === "idle" && m.outcome === "failed"), "failed idle history")
  const exhaustedRequests = (await trace()).requests.slice(exhaustStart).filter((row) => !row.auxiliary)
  proof.exhaustion = { id: exhaustedID, requests: exhaustedRequests, history: exhaustedHistory,
    session: (await api("get", `/api/session/${exhaustedID}`)).data }
  assert.ok(exhaustedRequests.length >= 2 && exhaustedRequests.length <= 12)
  assert.deepEqual([...new Set(exhaustedRequests.map((row) => row.model))], ["selected", "composer"])
  assert.ok(exhaustedRequests.every((row) => row.failure === "rate-limit" && !row.emitRead))
  await control("/failure", { mode: "none", remaining: 0 })
  await delay(Math.max(0, exhaustedRequests.at(-1).at + 31_000 - Date.now()))
  const retryID = await open("QM admission and clean retry")
  proof.retry = { id: retryID, admission: await send(retryID, "qm-managed-retry-admission", [["selected", null]]) }
  await control("/failure", { mode: "rate-limit", remaining: 1, model: "selected" })
  proof.retry.fallback = await send(retryID, "qm-managed-retry", [["selected", null], ["composer", null]])
  assert.equal(proof.retry.fallback.requests[0].failure, "rate-limit")
  assert.equal(proof.retry.fallback.requests[1].failure, null)
  proof.casesPassed = true
} catch (error) {
  proof.error = String(error)
  throw error
} finally {
  try {
    if (fixture) {
      await control("/failure", { mode: "none", remaining: 0 })
      await control("/release")
      await control("/online")
      proof.restored = await trace()
      assert.equal(proof.restored.waiting, 0)
    }
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve))
      child.kill()
      await exited
    }
    proof.cleanup = true
    proof.passed = proof.casesPassed === true && proof.restored?.failure.mode === "none" && proof.restored.waiting === 0
    if (fixture) await writeFile(join(fixture.directory, "tail-proof.json"), JSON.stringify(proof, null, 2))
  }
}
console.log(JSON.stringify({ passed: proof.passed, directory: fixture.directory,
  runtime: { version: proof.info.version, pid: proof.info.pid, urls: proof.info.urls },
  pluginRoot: fixture.pluginRoot,
  partial: proof.partial.id, controls: proof.controls.id, exhaustion: proof.exhaustion.id,
  retry: proof.retry.id, cleanup: proof.cleanup }, null, 2))
