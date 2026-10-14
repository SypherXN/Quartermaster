import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { runRoutingProof } from "./managed-routing-case.mjs"

// Uses the existing authenticated stock server, never starts an OpenCode host.
const host = process.env.OPENCODE_PERMISSION_REVIEWER_HOST_URL
assert.match(host ?? "", /^http:\/\/127\.0\.0\.1:\d+$/)
const exe = process.argv.find((arg) => arg.startsWith("--executable="))?.slice(13) ?? join(homedir(), ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode")
const pluginArg = process.argv.find((arg) => arg.startsWith("--plugin-root="))
const faultOnly = process.argv.includes("--failed-switch-only")
const ownershipOnly = process.argv.includes("--ownership-only")
const lifecycleOnly = process.argv.includes("--lifecycle-only")
const onlyCase = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7)
assert.ok(!onlyCase || ["source", "queued", "queuedSafety", "failedSwitch", "ownership", "cancellation", "toolChild", "lifecycle", "routingProof"].includes(onlyCase), "Unknown verification case")
const routingProof = onlyCase === "routingProof"
assert.ok([faultOnly, ownershipOnly, lifecycleOnly].filter(Boolean).length <= 1, "Choose one verification mode")
const child = spawn(process.execPath, ["scripts/prepare-managed-host-fixture.mjs", ...(faultOnly ? ["--fail-switch"] : []), ...(routingProof ? ["--routing-proof"] : []), ...(pluginArg ? [pluginArg] : [])], { windowsHide: true, stdio: ["ignore", "pipe", "inherit"] })
let fixture
const proof = { host, cases: {}, sessions: [], startedAt: new Date().toISOString(), faultInjection: faultOnly ? "Fixture adapter throws once at switchModel; not a native host rejection" : null }
function api(method, path, body, allowFailure = false, directory = fixture.directory) {
  const args = ["api", "--server", host, method, path + (path.includes("?") ? "&" : "?") + new URLSearchParams({ "location[directory]": directory })]
  if (body !== undefined) args.push("--data", JSON.stringify(body))
  const r = spawnSync(exe, args, { encoding: "utf8", timeout: 60_000, windowsHide: true })
  if (allowFailure) return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  assert.equal(r.status, 0, `${method} ${path}: ${r.stderr || r.stdout || String(r.error ?? "CLI call did not exit successfully")}`)
  return r.stdout.trim() ? JSON.parse(r.stdout) : null
}
const control = (path) => fetch(fixture.baseURL + path, { method: "POST", headers: { connection: "close" }, signal: AbortSignal.timeout(5_000) })
const trace = () => fetch(fixture.traceURL, { headers: { connection: "close" }, signal: AbortSignal.timeout(5_000) }).then((r) => r.json())
const diagnose = (sessionID) => api("post", "/api/rpc/quartermaster/diagnoseSession", { input: { sessionID } }).output
async function until(read, check, label, attempts = 50, gapMs = 200) {
  for (let i = 0; i < attempts; i++) { const value = await read(); if (check(value)) return value; await delay(gapMs) }
  throw Error(`Timed out: ${label}`)
}
function session(agent) {
  const created = api("post", "/api/session", { title: `Quartermaster managed boundary: ${agent}`, location: { directory: fixture.directory } })
  const id = (created.data ?? created).id
  proof.sessions.push(id)
  api("post", `/api/session/${id}/agent`, { agent })
  api("post", `/api/session/${id}/model`, { model: { providerID: fixture.providers.initial, id: "composer" } })
  assert.equal(diagnose(id).session.scope, "confirmed-project", "creation must specify the actual location in its body")
  return id
}
const prompt = (id, text) => api("post", `/api/session/${id}/prompt`, { text, delivery: "queue", resume: true })
const idle = (id) => until(async () => {
  try { return api("get", `/api/session/${id}`).data }
  catch (error) {
    if (!String(error).includes("Could not reach server")) throw error
    await delay(250) // One retry of a read only; never repeat a rejected mutation.
    return api("get", `/api/session/${id}`).data
  }
}, (s) => s.time.idle !== undefined && s.outcome === "succeeded", "session completion")
async function record(name, run) {
  if (onlyCase && onlyCase !== name) return
  try { proof.cases[name] = { passed: true, evidence: await run() } }
  catch (error) {
    const failed = proof.cases[name] = { passed: false, error: String(error), cause: String(error.cause ?? ""), stack: error.stack }
    try { failed.diagnostic = diagnose(proof.sessions.at(-1)); failed.options = api("post", "/api/rpc/quartermaster/status", { input: {} }).output }
    catch (readError) { failed.diagnosticError = String(readError) }
    console.error(`${name}: ${error}`)
  }
  await writeFile(join(fixture.directory, "boundary-proof.json"), JSON.stringify(proof, null, 2))
}
try {
  fixture = await new Promise((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => reject(Error("Fixture startup timed out")), 5_000)
    child.once("error", reject)
    child.stdout.on("data", (chunk) => { output += chunk; const end = output.indexOf("\n}"); if (end !== -1) { clearTimeout(timer); resolve(JSON.parse(output.slice(0, end + 2))) } })
  })
  proof.fixture = fixture
  if (pluginArg) assert.equal(fixture.pluginRoot, resolve(pluginArg.slice(14)))
  proof.info = api("get", "/api/info")
  proof.reviewer = api("post", "/api/rpc/opencode-permission-reviewer/status", { input: {} }).output
  if (onlyCase === "source") await record("source", async () => {
    const id = session("qm-managed-test"), report = diagnose(id)
    assert.equal(report.runtime.processID, proof.info.pid)
    const plugin = api("get", "/api/plugin").data.find((entry) => entry.id === "quartermaster")
    assert.equal(plugin?.state.status, "active", "The handling plugin must be active")
    const target = plugin.source.path ?? plugin.source.target
    assert.equal(typeof target, "string", "Installed source identity must be available")
    const normalize = (path) => {
      const value = resolve(path.startsWith("file:") ? fileURLToPath(path) : path)
      return process.platform === "win32" ? value.toLowerCase() : value
    }
    assert.ok([fixture.pluginRoot, join(fixture.pluginRoot, "index.js")].map(normalize).includes(normalize(target)), "The active source must be the installed artifact, not the checkout")
    return { id, plugin, report }
  })
  if (!faultOnly && !ownershipOnly && !lifecycleOnly) await record("queued", async () => {
    const id = session("qm-managed-queued")
    await control("/hold")
    try {
      prompt(id, "qm-managed-held")
      await until(trace, (t) => t.waiting === 1, "held primary")
      const before = diagnose(id)
      assert.equal(before.session.activePrimary, true)
      prompt(id, "qm-managed-queued")
      const during = diagnose(id), inbox = api("get", `/api/session/${id}/inbox`), held = await trace()
      assert.equal(during.session.model.modelID, "selected")
      assert.equal(held.requests.filter((r) => !r.auxiliary).length, 1)
      await control("/offline")
      await delay(5_100) // Expire the documented local-health cache before dequeue.
      await control("/release")
      const after = await until(trace, (t) => t.requests.some((r) => r.marker === "qm-managed-queued"), "dequeued provider send")
      proof.queuedObservation = { id, before, during, inbox, held, after }
      assert.deepEqual(after.requests.filter((r) => r.marker === "qm-managed-queued" && !r.auxiliary).map((r) => r.model), ["composer"], "dequeued turn must select using execution-boundary health")
      await idle(id)
      return proof.queuedObservation
    } finally { await control("/release"); await control("/online") }
  })
  if (!faultOnly && !ownershipOnly && !lifecycleOnly) await record("queuedSafety", async () => {
    const id = session("qm-managed-queued")
    await control("/hold")
    try {
      prompt(id, "qm-managed-safety-held")
      await until(trace, (t) => t.waiting === 1, "held safety primary")
      prompt(id, "qm-managed-safety-queued")
      const inbox = api("get", `/api/session/${id}/inbox`), held = await trace()
      assert.equal(held.requests.filter((r) => !r.auxiliary).length, 1)
      await control("/offline")
      await delay(5_100)
      await control("/release")
      // Stock host can append a later successful idle marker; retain the actual failed marker.
      const rejected = await until(() => api("get", `/api/session/${id}/message?limit=10&order=desc`).data,
        (messages) => messages.some((m) => m.type === "idle" && m.outcome === "failed"), "queued safety rejection")
      const after = await trace(), report = diagnose(id)
      proof.queuedSafetyObservation = { id, inbox, held, rejected, after, report }
      assert.equal(after.requests.filter((r) => !r.auxiliary).length, 1, "stale queued model must never reach either provider")
      assert.equal(report.availability.localHealth[fixture.providers.selected], "offline")
      // Other sessions' manual and unbound choices remain untouched even while selected is offline.
      for (const [agent, marker, model] of [
        ["qm-managed-test", "qm-managed-safety-manual", "composer"],
        ["qm-managed-test", "qm-managed-safety-manual-offline", "selected"],
        ["qm-managed-unbound", "qm-managed-safety-unbound", "composer"],
      ]) {
        const other = session(agent)
        if (agent === "qm-managed-test") api("post", `/api/session/${other}/command`, { name: "qm-manual", text: "" })
        if (model === "selected") api("post", `/api/session/${other}/model`, {
          model: { providerID: fixture.providers.selected, id: "selected", variant: "deliberate" },
        })
        prompt(other, marker)
        await idle(other)
        assert.deepEqual((await trace()).requests.filter((r) => r.marker === marker && !r.auxiliary).map((r) => [r.model, r.variant]),
          [[model, model === "selected" ? "deliberate" : null]])
      }
      await control("/online")
      await delay(5_100)
      const recoveryID = session("qm-managed-test")
      prompt(recoveryID, "qm-managed-safety-recovery")
      await idle(recoveryID)
      const recovered = await trace()
      assert.deepEqual(recovered.requests.filter((r) => r.marker === "qm-managed-safety-recovery" && !r.auxiliary).map((r) => r.model), ["selected"])
      return { ...proof.queuedSafetyObservation, recoveryID, recovered, limit: "Pre-send rejection, not transparent queued reselection" }
    } finally { await control("/release"); await control("/online") }
  })
  if (faultOnly) await record("failedSwitch", async () => {
    const id = session("qm-managed-broken"), before = await trace()
    const rejected = api("post", `/api/session/${id}/prompt`, { text: "qm-managed-broken", delivery: "queue", resume: true }, true)
    const report = diagnose(id), after = await trace()
    proof.switchObservation = { id, rejected, report, before, after }
    assert.notEqual(rejected.status, 0, "injected switch failure must fail admission")
    assert.match(rejected.stderr + rejected.stdout, /HTTP 500/, "stock CLI exposes only status for this hook error")
    assert.equal(after.switchFaults, 1, "fixture adapter must record the injected failure")
    assert.equal(after.requests.length, before.requests.length, "failed switch must send neither selected nor composer")
    const recoveryID = session("qm-managed-test")
    prompt(recoveryID, "qm-managed-recovery")
    const recovered = await until(trace, (t) => t.requests.some((r) => r.marker === "qm-managed-recovery"), "released reservation")
    assert.deepEqual(recovered.requests.filter((r) => r.marker === "qm-managed-recovery" && !r.auxiliary).map((r) => r.model), ["selected"])
    await idle(recoveryID)
    return { ...proof.switchObservation, recoveryID, recovered }
  })
  if (ownershipOnly) await record("ownership", async () => {
    const id = session("qm-managed-test"), observations = []
    const model = (providerID, modelID, variant) => api("post", `/api/session/${id}/model`, {
      model: { providerID, id: modelID, ...(variant ? { variant } : {}) },
    })
    const command = (name) => api("post", `/api/session/${id}/command`, { name, text: "" })
    const send = async (marker, expectedModel, variant = null, mode = "automatic") => {
      prompt(id, marker)
      const requests = await until(trace, (t) => t.requests.some((r) => r.marker === marker), marker)
      const primary = requests.requests.filter((r) => r.marker === marker && !r.auxiliary)
      assert.deepEqual(primary.map((r) => [r.model, r.variant]), [[expectedModel, variant]])
      await idle(id)
      const report = diagnose(id)
      assert.equal(report.session.mode, mode)
      observations.push({ marker, primary, report })
    }
    model(fixture.providers.initial, "composer", "deliberate")
    await send("qm-managed-ownership-auto", "selected")
    command("qm-manual")
    model(fixture.providers.selected, "selected", "deliberate")
    await send("qm-managed-ownership-same", "selected", "deliberate", "manual")
    model(fixture.providers.initial, "composer", "deliberate")
    await send("qm-managed-ownership-outside", "composer", "deliberate", "manual")
    // Stored opt-out also applies to later idle prompts without repeating the command.
    await send("qm-managed-ownership-later", "composer", "deliberate", "manual")
    command("qm-auto")
    await send("qm-managed-ownership-resume", "selected")
    command("qm-manual")
    api("post", `/api/session/${id}/agent`, { agent: "qm-managed-unbound" })
    model(fixture.providers.initial, "composer", "deliberate")
    await send("qm-managed-ownership-unbound", "composer", "deliberate", "unbound")
    api("post", `/api/session/${id}/agent`, { agent: "qm-managed-test" })
    await send("qm-managed-ownership-agent-return", "selected")
    command("qm-manual")
    const other = session("qm-managed-test")
    assert.equal(diagnose(other).session.mode, "automatic")
    assert.equal(diagnose(id).session.mode, "manual")
    const foreignDirectory = await mkdtemp(join(dirname(fixture.directory), "qm-foreign-"))
    await copyFile(join(fixture.directory, "opencode.json"), join(foreignDirectory, "opencode.json"))
    const created = api("post", "/api/session", { title: "Quartermaster foreign-scope fixture", location: { directory: foreignDirectory } }, false, foreignDirectory)
    const foreignSession = (created.data ?? created).id
    proof.sessions.push(foreignSession)
    const mismatch = diagnose(foreignSession)
    assert.ok(["mismatch", "unknown"].includes(mismatch.session.scope), "a foreign session must not be reported as owned")
    assert.equal(mismatch.session.agent, "unknown")
    assert.equal(mismatch.session.model, "unknown")
    return { id, observations, independentSession: other, mismatch }
  })
  if (ownershipOnly) await record("cancellation", async () => {
    const id = session("qm-managed-test")
    await control("/hold")
    try {
      prompt(id, "qm-managed-cancel-held")
      await until(trace, (t) => t.waiting === 1, "cancellation held primary")
      const busy = session("qm-managed-queued")
      prompt(busy, "qm-managed-busy-fallback")
      await until(trace, (t) => t.requests.some((r) => r.marker === "qm-managed-busy-fallback"), "busy fallback")
      const before = await trace()
      assert.deepEqual(before.requests.filter((r) => r.marker === "qm-managed-busy-fallback" && !r.auxiliary).map((r) => r.model), ["composer"])
      const interrupted = api("post", `/api/session/${id}/interrupt?resume=false`)
      assert.equal(interrupted.interrupted, true)
      await control("/release")
      await idle(busy)
      const report = await until(() => diagnose(id), (d) => d.session.activePrimary === false, "interruption cleanup")
      const recovery = session("qm-managed-test")
      prompt(recovery, "qm-managed-cancel-recovery")
      const after = await until(trace, (t) => t.requests.some((r) => r.marker === "qm-managed-cancel-recovery"), "exclusive recovery after cancellation")
      assert.deepEqual(after.requests.filter((r) => r.marker === "qm-managed-cancel-recovery" && !r.auxiliary).map((r) => r.model), ["selected"])
      await idle(recovery)
      return { id, busy, recovery, interrupted, before, report, after }
    } finally { await control("/release") }
  })
  if (lifecycleOnly) await record("lifecycle", async () => {
    const id = session("qm-managed-test")
    api("post", `/api/session/${id}/command`, { name: "qm-manual", text: "" })
    api("post", `/api/session/${id}/model`, { model: { providerID: fixture.providers.initial, id: "composer", variant: "deliberate" } })
    prompt(id, "qm-managed-before-reload")
    await idle(id)
    const before = diagnose(id)
    assert.equal(before.session.mode, "manual")
    assert.equal(before.primaryRequestEvidence.lastObserved.model.modelID, "composer")
    const configPath = join(fixture.directory, "opencode.json"), original = await readFile(configPath, "utf8")
    const backup = configPath + ".lifecycle.bak"
    await copyFile(configPath, backup)
    assert.equal(await readFile(backup, "utf8"), original)
    // Native scoped eviction boots fresh services on next use; no global reload.
    api("delete", "/api/debug/location")
    const reloaded = diagnose(id)
    assert.notEqual(reloaded.runtime.pluginInstanceID, before.runtime.pluginInstanceID)
    assert.equal(reloaded.runtime.processID, before.runtime.processID)
    assert.equal(reloaded.session.mode, "manual")
    prompt(id, "qm-managed-after-reload")
    await idle(id)
    const seen = await trace()
    assert.deepEqual(seen.requests.filter((r) => /qm-managed-(before|after)-reload/.test(r.marker ?? "") && !r.auxiliary).map((r) => [r.model, r.variant]), [["composer", "deliberate"], ["composer", "deliberate"]])
    api("delete", `/api/session/${id}`)
    const deleted = await until(() => diagnose(id), (d) => d.primaryRequestEvidence.lastObserved === "unknown", "deletion event cleanup")
    assert.equal(deleted.session.agent, "unknown")
    assert.equal(deleted.session.model, "unknown")
    const freshID = session("qm-managed-test")
    assert.equal(diagnose(freshID).session.mode, "automatic")
    prompt(freshID, "qm-managed-after-delete")
    await idle(freshID)
    const recovered = await trace()
    assert.deepEqual(recovered.requests.filter((r) => r.marker === "qm-managed-after-delete" && !r.auxiliary).map((r) => r.model), ["selected"])
    assert.equal(await readFile(configPath, "utf8"), original, "scoped reload must not change config")
    // Same model IDs deliberately shared between two disposable projects.
    // Leases and ownership must belong to their handling plugin instance.
    const otherDirectory = await mkdtemp(join(dirname(fixture.directory), "qm-isolation-"))
    await writeFile(join(otherDirectory, "opencode.json"), original)
    const otherApi = (method, path, body) => api(method, path, body, false, otherDirectory)
    const otherID = otherApi("post", "/api/session", { title: "QM project isolation", location: { directory: otherDirectory } }).data.id
    proof.sessions.push(otherID)
    otherApi("post", `/api/session/${otherID}/agent`, { agent: "qm-managed-test" })
    otherApi("post", `/api/session/${otherID}/model`, { model: { providerID: fixture.providers.initial, id: "composer" } })
    const other = otherApi("post", "/api/rpc/quartermaster/diagnoseSession", { input: { sessionID: otherID } }).output
    const own = diagnose(freshID)
    assert.notEqual(other.location.projectID, own.location.projectID)
    assert.notEqual(other.runtime.pluginInstanceID, own.runtime.pluginInstanceID)
    assert.equal(other.runtime.processID, own.runtime.processID)
    assert.equal(other.session.mode, "automatic")
    await control("/hold")
    try {
      prompt(freshID, "qm-managed-isolation-held")
      await until(trace, (t) => t.waiting === 1, "isolation held primary")
      otherApi("post", `/api/session/${otherID}/prompt`, { text: "qm-managed-isolation-other", delivery: "queue", resume: true })
      const shared = await until(trace, (t) => t.requests.some((r) => r.marker === "qm-managed-isolation-other"), "other project admission")
      assert.deepEqual(shared.requests.filter((r) => r.marker === "qm-managed-isolation-other" && !r.auxiliary).map((r) => r.model), ["selected"])
      assert.equal(shared.waiting, 2)
      proof.lifecycleObservation = { id, backup, before, reloaded, deleted, freshID, recovered, otherDirectory, otherID, other, own, shared }
      await control("/release")
      await idle(freshID)
      await until(() => otherApi("get", `/api/session/${otherID}`).data, (s) => s.time.idle && s.outcome === "succeeded", "other project idle")
      return { id, backup, before, reloaded, deleted, freshID, recovered, otherDirectory, otherID, other, own, shared }
    } finally { await control("/release") }
  })
  if (!faultOnly && !lifecycleOnly) await record("toolChild", async () => {
    const id = session("qm-managed-spawner")
    prompt(id, "qm-managed-spawn")
    const requests = await until(trace, (t) => t.requests.some((r) => r.marker === "qm-managed-child"), "tool-created child primary")
    const children = api("get", `/api/session?parentID=${id}&directory=${encodeURIComponent(fixture.directory)}`).data
    const childSession = children.find((s) => s.parentID === id && s.agent === "qm-managed-child")
    assert.ok(childSession, "native tool must create a real child, not a fork or directly created session")
    const report = diagnose(childSession.id)
    assert.equal(report.session.mode, "automatic")
    assert.equal(report.session.model.modelID, "selected")
    assert.deepEqual(requests.requests.filter((r) => r.marker === "qm-managed-child" && !r.auxiliary).map((r) => r.model), ["selected"])
    await idle(id)
    const later = []
    if (ownershipOnly) {
      await idle(childSession.id)
      const childModel = () => api("post", `/api/session/${childSession.id}/model`, {
        model: { providerID: fixture.providers.initial, id: "composer", variant: "deliberate" },
      })
      for (const [suffix, mode, expectedModel, variant] of [
        ["idle", "automatic", "selected", null],
        ["manual", "manual", "composer", "deliberate"],
        ["resume", "automatic", "selected", null],
      ]) {
        if (suffix !== "idle") api("post", `/api/session/${childSession.id}/command`, { name: suffix === "manual" ? "qm-manual" : "qm-auto", text: "" })
        childModel()
        const marker = `qm-managed-child-${suffix}`
        prompt(childSession.id, marker)
        const seen = await until(trace, (t) => t.requests.some((r) => r.marker === marker), marker)
        const primary = seen.requests.filter((r) => r.marker === marker && !r.auxiliary)
        assert.deepEqual(primary.map((r) => [r.model, r.variant]), [[expectedModel, variant]])
        await idle(childSession.id)
        const diagnostic = diagnose(childSession.id)
        assert.equal(diagnostic.session.mode, mode)
        later.push({ marker, primary, report: diagnostic })
      }
    }
    return { id, child: childSession, report, requests, later }
  })
  if (routingProof) await record("routingProof", () => runRoutingProof({ fixture, proof, api, trace, control, diagnose, session, prompt, idle, until }))
} finally {
  try {
    if (fixture) {
      await control("/release")
      await control("/online")
      await fetch(fixture.baseURL + "/failure", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "none", remaining: 0 }), signal: AbortSignal.timeout(5_000) })
      proof.finalTrace = await trace()
      await writeFile(join(fixture.directory, "boundary-proof.json"), JSON.stringify(proof, null, 2))
      console.log(JSON.stringify({ directory: fixture.directory, runtime: { version: proof.info?.version, pid: proof.info?.pid }, source: proof.cases.source?.evidence?.plugin, cases: Object.fromEntries(Object.entries(proof.cases).map(([name, result]) => [name, { passed: result.passed, error: result.error, cause: result.cause }])) }, null, 2))
    }
  } finally {
    if (child.pid && child.exitCode === null) { const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill(); await exited }
    if (fixture) {
      proof.cleanup = true
      proof.passed = Object.values(proof.cases).every((result) => result.passed) && proof.finalTrace.waiting === 0 && proof.finalTrace.failure.mode === "none"
      await writeFile(join(fixture.directory, "boundary-proof.json"), JSON.stringify(proof, null, 2))
    }
  }
}
assert.ok(!onlyCase || Object.hasOwn(proof.cases, onlyCase), "Requested case is not enabled in this verification mode")
if (Object.values(proof.cases).some((result) => !result.passed)) process.exitCode = 1
