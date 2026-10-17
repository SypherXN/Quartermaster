import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"

test("managed reproduction tools include syntax-valid helpers without historical session IDs", async () => {
  for (const path of [
    "scripts/verify-routing-tail.mjs", "scripts/verify-managed-host-boundaries.mjs", "scripts/verify-stock-ui.mjs",
    "scripts/prepare-managed-host-fixture.mjs", "scripts/managed-routing-case.mjs",
    "scripts/managed-routing-proof/index.ts", "scripts/managed-switch-fault/index.ts",
  ]) {
    const source = await readFile(path, "utf8")
    assert.doesNotMatch(source, /ses_[A-Za-z0-9]{20,}/, `${path} must create its own sessions`)
    const checked = spawnSync(process.execPath, ["--check", path], { encoding: "utf8", timeout: 5_000, windowsHide: true })
    assert.equal(checked.status, 0, `${path}: ${checked.stderr || String(checked.error ?? "syntax check failed")}`)
  }
})

test("managed fixture observes multipart markers and bounded held responses", { timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, ["scripts/prepare-managed-host-fixture.mjs"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let fixture
  try {
    fixture = await new Promise((resolve, reject) => {
      let output = ""
      const timer = setTimeout(() => reject(new Error("Fixture startup timed out")), 5_000)
      child.once("error", reject)
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Fixture exited before startup")) })
      child.stdout.on("data", (chunk) => {
        output += chunk
        const end = output.indexOf("\n}")
        if (end !== -1) { clearTimeout(timer); resolve(JSON.parse(output.slice(0, end + 2))) }
      })
    })
    const config = JSON.parse(await readFile(join(fixture.directory, "opencode.json"), "utf8"))
    const settings = JSON.parse(await readFile(join(fixture.directory, "quartermaster.jsonc"), "utf8"))
    assert.deepEqual(Object.keys(config.providers), [fixture.providers.initial, fixture.providers.selected])
    assert.ok(fixture.providers.selected.includes(basename(fixture.directory)))
    assert.equal(config.plugins[0].options, undefined)
    assert.deepEqual(settings.plans.admission, [`${fixture.providers.selected}/selected`])
    const request = (path, options) => fetch(fixture.baseURL + path, { ...options, signal: AbortSignal.timeout(5_000) })
    await request("/hold", { method: "POST" })
    const response = await request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-qm-fixture-variant": "deliberate" },
      body: JSON.stringify({ model: "selected", messages: [{ role: "user", content: [{ type: "text", text: "qm-managed-held" }, { type: "text", text: "Host-added instructions" }] }] }) })
    const trace = await request("/trace").then((r) => r.json())
    assert.equal(trace.waiting, 1)
    assert.equal(trace.requests[0].marker, "qm-managed-held")
    assert.equal(trace.requests[0].auxiliary, false)
    assert.equal(trace.requests[0].variant, "deliberate")
    await request("/release", { method: "POST" })
    assert.match(await response.text(), /\[DONE\]/)
    assert.equal((await request("/trace").then((r) => r.json())).waiting, 0)
    await request("/offline", { method: "POST" })
    assert.equal((await request("/health")).status, 503)
    await request("/online", { method: "POST" })
    assert.equal((await request("/health")).status, 200)
    const delegated = await request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "composer", messages: [{ role: "user", content: "qm-managed-spawn" }] }) }).then((r) => r.text())
    assert.match(delegated, /"name":"subagent"/)
    assert.match(delegated, /qm-managed-child/)
    const finished = await request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "composer", messages: [{ role: "user", content: "qm-managed-spawn" }, { role: "tool", content: "OK" }] }) }).then((r) => r.text())
    assert.doesNotMatch(finished, /tool_calls/)
    assert.equal((await request("/failure", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "rate-limit", remaining: 1, model: "selected" }) })).status, 204)
    const denied = await request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "selected", messages: [{ role: "user", content: "qm-managed-limit" }] }) })
    assert.equal(denied.status, 429)
    const recovered = await request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "selected", messages: [{ role: "user", content: "qm-managed-limit-ok" }] }) })
    assert.match(await recovered.text(), /\[DONE\]/)
    await request("/failure", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "partial", remaining: 1, model: "composer" }) })
    const partialBody = await request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "composer", messages: [{ role: "user", content: "qm-managed-partial-fixture" }] }) }).then((r) => r.text())
    assert.match(partialBody, /PARTIAL/)
    assert.doesNotMatch(partialBody, /\[DONE\]/)
    const failures = await request("/trace").then((r) => r.json())
    assert.equal(failures.requests.find((r) => r.marker === "qm-managed-limit").failure, "rate-limit")
    assert.equal(failures.requests.find((r) => r.marker === "qm-managed-partial-fixture").failure, "partial")
    assert.equal(failures.requests.find((r) => r.marker === "qm-managed-limit-ok").failure, null)
  } finally {
    if (child.pid && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve))
      child.kill()
      await exited
    }
    if (fixture) { assert.match(basename(fixture.directory), /^qm-managed-/); await rm(fixture.directory, { recursive: true }) }
  }
})

test("routing-proof fixture keeps the default package and adds a recoverable plan", { timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, ["scripts/prepare-managed-host-fixture.mjs", "--routing-proof", "--tool-proof"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let fixture
  try {
    fixture = await new Promise((resolve, reject) => {
      let output = ""
      const timer = setTimeout(() => reject(new Error("Fixture startup timed out")), 5_000)
      child.once("error", reject)
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Fixture exited before startup")) })
      child.stdout.on("data", (chunk) => {
        output += chunk
        const end = output.indexOf("\n}")
        if (end !== -1) { clearTimeout(timer); resolve(JSON.parse(output.slice(0, end + 2))) }
      })
    })
    const config = JSON.parse(await readFile(join(fixture.directory, "opencode.json"), "utf8"))
    const settings = JSON.parse(await readFile(join(fixture.directory, "quartermaster.jsonc"), "utf8"))
    const selected = `${fixture.providers.selected}/selected`
    const composer = `${fixture.providers.initial}/composer`
    assert.equal(config.plugins.length, 1)
    assert.equal(config.plugins[0].options, undefined)
    assert.deepEqual(settings.plans.recover, [selected, composer])
    assert.equal(settings.agents["qm-managed-recover"], "recover")
    assert.equal(settings.providerCooldownMs, 30_000)
    assert.equal(settings.usageSources, undefined)
    assert.equal(config.agents["qm-managed-recover"].model, composer)
    const request = (path, body) => fetch(fixture.baseURL + path, { method: "POST", signal: AbortSignal.timeout(5_000),
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    assert.equal((await request("/failure", { mode: "partial-after-tool", remaining: 1, model: "selected" })).status, 204)
    const user = { role: "user", content: "qm-managed-tool-once" }
    const tool = { role: "tool", tool_call_id: "managed-read-once", content: "QM read-once proof" }
    const first = await request("/v1/chat/completions", { model: "selected", messages: [user], tools: [{ type: "function", function: { name: "read", parameters: { properties: { path: { type: "string" } } } } }] }).then((r) => r.text())
    assert.match(first, /managed-read-once/)
    assert.match(first, /tool-proof\.txt/)
    assert.match(first, /"finish_reason":"tool_calls"/)
    const partial = await request("/v1/chat/completions", { model: "selected", messages: [user, tool] }).then((r) => r.text())
    assert.match(partial, /PARTIAL/)
    assert.doesNotMatch(partial, /\[DONE\]/)
    const continued = await request("/v1/chat/completions", { model: "selected", messages: [tool, { role: "assistant", content: "PARTIAL" }] }).then((r) => r.text())
    assert.match(continued, /\[DONE\]/)
    assert.doesNotMatch(continued, /tool_calls/)
    const trace = await fetch(fixture.traceURL, { signal: AbortSignal.timeout(5_000) }).then((r) => r.json())
    assert.deepEqual(trace.requests.map((row) => row.failure), [null, "partial-after-tool", null])
    assert.equal(trace.requests.filter((row) => row.emitRead).length, 1)
    assert.deepEqual(trace.requests[1].toolResultIDs, ["managed-read-once"])
    assert.equal(trace.requests[2].marker, null)
    assert.equal(trace.failure.remaining, 0)
  } finally {
    if (child.pid && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve))
      child.kill()
      await exited
    }
    if (fixture) await rm(fixture.directory, { recursive: true })
  }
})

test("managed fixture uses the supplied package even through its switch-failure adapter", { timeout: 15_000 }, async () => {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const packageRoot = await mkdtemp(join(base, "qm-package-fixture-"))
  await writeFile(join(packageRoot, "index.js"), "export default { id: 'quartermaster' }\n")
  const child = spawn(process.execPath, ["scripts/prepare-managed-host-fixture.mjs", `--plugin-root=${packageRoot}`, "--fail-switch"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let fixture
  try {
    fixture = await new Promise((resolve, reject) => {
      let output = ""
      const timer = setTimeout(() => reject(Error("Fixture startup timed out")), 5_000)
      child.once("error", (error) => { clearTimeout(timer); reject(error) })
      child.once("exit", () => { clearTimeout(timer); reject(Error("Fixture exited before startup")) })
      child.stdout.on("data", (chunk) => {
        output += chunk
        const end = output.indexOf("\n}")
        if (end !== -1) { clearTimeout(timer); resolve(JSON.parse(output.slice(0, end + 2))) }
      })
    })
    const config = JSON.parse(await readFile(join(fixture.directory, "opencode.json"), "utf8"))
    assert.equal(fixture.pluginRoot, packageRoot)
    assert.equal(config.plugins[0].package, fixture.pluginPackage)
    const adapter = await readFile(join(fixture.pluginPackage, "index.ts"), "utf8")
    assert.ok(adapter.includes(JSON.stringify(pathToFileURL(join(packageRoot, "index.js")).href)))
    assert.ok(adapter.includes("Injected fixture client switch failure"))
    assert.ok(!adapter.includes('"../../index.js"'))
  } finally {
    if (child.pid && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill(); await exited
    }
    if (fixture) await rm(fixture.directory, { recursive: true })
    await rm(packageRoot, { recursive: true })
  }
})
