import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Service } from "@opencode/client/service"
import { parseConfig } from "../src/config.ts"
import { ModuleCooldowns } from "../src/modules.ts"
import { adoptProjectQuartermasterOptions, ProjectConfigurationUnresolved, readInstalledConfiguration, readNativeConfiguration, readProjectQuartermasterOptions } from "../src/project-options.ts"

test("a different registered service still reads this process when its listen port matches", async t => {
  let ownPid = process.pid
  let serviceConfigReads = 0
  let ownConfigReads = 0
  const service = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1")
    response.setHeader("Content-Type", "application/json")
    if (url.pathname === "/api/info") {
      response.end(JSON.stringify({ version: "2.0.31", pid: process.pid + 1, urls: [], paths: {}, capabilities: {} }))
      return
    }
    serviceConfigReads += 1
    response.statusCode = 500
    response.end("{}")
  })
  const own = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1")
    response.setHeader("Content-Type", "application/json")
    if (url.pathname === "/api/info") {
      response.end(JSON.stringify({ version: "2.0.31", pid: ownPid, urls: [], paths: {}, capabilities: {} }))
      return
    }
    assert.equal(url.pathname, "/api/config")
    assert.equal(url.searchParams.get("location[directory]"), "/opr")
    ownConfigReads += 1
    response.end("[]")
  })
  await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve))
  await new Promise<void>(resolve => own.listen(0, "127.0.0.1", resolve))
  const ownPort = (own.address() as { port: number }).port
  const discover = t.mock.method(Service, "discover", async () => ({
    url: `http://127.0.0.1:${(service.address() as { port: number }).port}`,
  }))
  const ensure = t.mock.method(Service, "ensure", async () => { throw new Error("must not start a server") })
  const listen = {
    argv: ["opencode", "serve", "--hostname", "127.0.0.1", "--port", String(ownPort)],
    env: {},
  }
  try {
    assert.deepEqual(await readNativeConfiguration("/opr", listen), [])
    assert.equal(serviceConfigReads, 0)
    assert.equal(ownConfigReads, 1)
    assert.equal(discover.mock.callCount(), 1)
    assert.equal(ensure.mock.callCount(), 0)
    ownPid = process.pid + 2
    await assert.rejects(() => readNativeConfiguration("/opr", listen), /provenance is unavailable/)
    assert.equal(serviceConfigReads, 0)
    assert.equal(ownConfigReads, 1)
    await assert.rejects(() => readNativeConfiguration("/opr", {
      argv: ["opencode", "serve", "--hostname", "10.0.0.8", "--port", String(ownPort)],
      env: {},
    }), /provenance is unavailable/)
    assert.equal(ownConfigReads, 1)
    assert.equal(ensure.mock.callCount(), 0)
  } finally {
    service.closeAllConnections()
    own.closeAllConnections()
    await new Promise<void>(resolve => service.close(() => resolve()))
    await new Promise<void>(resolve => own.close(() => resolve()))
  }
})

test("installed files supply opr-jev when loopback provenance cannot authenticate", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-installed-config-"))
  const home = join(root, "home")
  const project = join(root, "project")
  const nested = join(project, "nested")
  const env = { OPENCODE_TEST_HOME: home, XDG_CONFIG_HOME: join(home, ".config") }
  const registration = JSON.stringify({ plugins: [{ package: "quartermaster" }] })
  try {
    await mkdir(join(home, ".config", "opencode"), { recursive: true })
    await mkdir(nested, { recursive: true })
    await writeFile(join(home, ".config", "opencode", "opencode.json"), registration)
    await writeFile(join(home, ".config", "opencode", "quartermaster.jsonc"), JSON.stringify({
      modules: { "opr-jev": { models: ["opencode/global-only"] } },
    }))
    await writeFile(join(project, "opencode.json"), registration)
    await writeFile(join(project, "quartermaster.jsonc"), JSON.stringify({
      modules: { "opr-jev": { cooldownMs: 300000, models: [{ id: "opencode/jev-1.13-free", cooldownMs: 900000 }, "opencode/jev-1.13"] } },
    }))
    const loaded = await readProjectQuartermasterOptions(nested, (directory) => readInstalledConfiguration(directory, env))
    const config = parseConfig({})
    Object.assign(config, loaded.config)
    const state = await ModuleCooldowns.load(config, { get: async () => undefined, set: async () => {} }, "project", () => 1_000)
    const accepted = await state.report({ module: "opr-jev", providerID: "opencode", modelID: "jev-1.13-free", reason: "rate-limit" })
    assert.equal(accepted.accepted, true)
    if (accepted.accepted) assert.equal(accepted.blockedUntil, 1_000 + 900_000)
    assert.equal((await state.report({ module: "opr-jev", providerID: "opencode", modelID: "jev-1.13", reason: "rate-limit" })).accepted, true)
    assert.deepEqual(await state.report({ module: "opr-jev", providerID: "opencode", modelID: "global-only", reason: "rate-limit" }), { accepted: false, reason: "unknown-model" })
    const globalOnly = await readProjectQuartermasterOptions(nested, (directory) => readInstalledConfiguration(directory, { ...env, OPENCODE_DISABLE_PROJECT_CONFIG: "1" }))
    assert.equal(globalOnly.config.modules?.["opr-jev"].models[0].modelID, "global-only")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a supplied provenance failure does not read installed OpenCode files", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-installed-config-skip-"))
  const config = parseConfig({})
  try {
    await assert.rejects(() => adoptProjectQuartermasterOptions(config, root, async () => {
      throw new ProjectConfigurationUnresolved("Receiving server configuration provenance is unavailable")
    }), /provenance is unavailable/)
    assert.equal(config.modules, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
