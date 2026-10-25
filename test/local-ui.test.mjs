import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { applyProjectQuartermasterOptions, parseProjectConfig, readProjectQuartermasterOptions } from "../src/project-options.ts"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { createLocalUiServer, ensureLocalUi, localUiListenError, localUiOwnerCount, releaseLocalUi, shouldOpenLocalUiBrowser, watchLocalUiParent } from "../src/local-ui.mjs"
import { fixtureConfiguration } from "./configuration-fixture.ts"

const report = { apiVersion: 1, status: "ok", projectID: "project-a", generatedAt: 1, totals: {}, costs: {} }
const plans = { apiVersion: 1, status: "unconfigured", plans: { review: ["provider/model"] }, agents: { reviewer: "review" }, workTypes: {}, sources: {} }

function locationBody() {
  return { directory: process.cwd(), project: { id: "project-a", directory: process.cwd() } }
}

test("local gateway scopes authenticated report RPC to its configured project", async (t) => {
  let upstreamRequest
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1")
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    if (url.pathname === "/api/rpc/quartermaster/report") {
      upstreamRequest = {
        method: request.method,
        url,
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      }
    }
    response.writeHead(200, { "content-type": "application/json" })
    if (url.pathname === "/api/location") response.end(JSON.stringify(locationBody()))
    else if (url.pathname.endsWith("/status")) response.end(JSON.stringify({ output: plans }))
    else response.end(JSON.stringify({ output: report }))
  })
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())))

  const upstreamPort = upstream.address().port
  const local = createLocalUiServer({
    openCodeURL: `http://127.0.0.1:${upstreamPort}`,
    token: "server-only-test-token",
    projectDirectory: process.cwd(),
    port: 0,
  })
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve, reject) => local.close((error) => error ? reject(error) : resolve())))

  const origin = `http://127.0.0.1:${local.address().port}`
  const response = await fetch(`${origin}/api/report`, {
    headers: { origin, "sec-fetch-site": "same-origin" },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ...report,
    plans: plans.plans,
    agents: plans.agents,
    workTypes: plans.workTypes,
    availability: { status: "unconfigured", sources: {} },
  })
  assert.equal(upstreamRequest.method, "POST")
  assert.equal(upstreamRequest.url.pathname, "/api/rpc/quartermaster/report")
  assert.equal(upstreamRequest.url.searchParams.get("location[directory]"), process.cwd())
  assert.equal(upstreamRequest.authorization, `Basic ${Buffer.from("opencode:server-only-test-token").toString("base64")}`)
  assert.deepEqual(upstreamRequest.body, { input: { limit: 50, offset: 0 } })

  const denied = await fetch(`${origin}/api/report`, {
    headers: { origin: "http://attacker.invalid", "sec-fetch-site": "cross-site" },
  })
  assert.equal(denied.status, 403)
})

test("local gateway allows direct navigation and rejects a bad or oversized report", async (t) => {
  let reports = 0
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1")
    if (url.pathname === "/api/location") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(reports === 0 ? locationBody() : { directory: process.cwd(), project: { id: "other-project", directory: process.cwd() } }))
      return
    }
    response.writeHead(200, { "content-type": "application/json" })
    response.end(++reports === 1
      ? JSON.stringify({ output: { apiVersion: 1, status: "ok", projectID: "other-project", totals: {}, costs: {} } })
      : `{"pad":"${"x".repeat(2_000_001)}"}`)
  })
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())))
  const local = createLocalUiServer({
    openCodeURL: `http://127.0.0.1:${upstream.address().port}`,
    token: "token",
    projectDirectory: process.cwd(),
    port: 0,
  })
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve, reject) => local.close((error) => error ? reject(error) : resolve())))
  const origin = `http://127.0.0.1:${local.address().port}`
  assert.equal((await fetch(origin, { headers: { "sec-fetch-site": "none" } })).status, 200)
  assert.equal((await fetch(`${origin}/api/report`, { headers: { "sec-fetch-site": "none" } })).status, 403)
  assert.equal((await fetch(`${origin}/api/report`)).status, 502)
  assert.equal((await fetch(`${origin}/api/report`)).status, 502)
  assert.equal((await fetch(`${origin}/missing`)).status, 404)
})

test("local gateway applies options only for its project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qm-ui-"))
  const other = await mkdtemp(join(tmpdir(), "qm-ui-other-"))
  const text = `{
    "model": "keep",
    "plugins": [{ "package": "quartermaster" }]
  }
`
  const settingsText = `{
  "plans": {
    "review": [
      "provider-a/old"
    ]
  }
}
`
  await writeFile(join(root, "opencode.json"), text)
  await writeFile(join(other, "opencode.json"), text)
  await writeFile(join(root, "quartermaster.jsonc"), settingsText)
  await writeFile(join(other, "quartermaster.jsonc"), settingsText)
  let locationDirectory = root
  let configReads = 0
  const upstream = createServer(async (request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    if (new URL(request.url, "http://127.0.0.1").pathname === "/api/config") {
      configReads += 1
      assert.equal(request.headers.authorization, `Basic ${Buffer.from("opencode:token").toString("base64")}`)
      assert.equal(new URL(request.url, "http://127.0.0.1").searchParams.get("location[directory]"), root)
      response.end(JSON.stringify(await fixtureConfiguration(root)))
    } else {
      response.end(JSON.stringify({ directory: locationDirectory, project: { id: "project-a", directory: locationDirectory } }))
    }
  })
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())))
  const local = createLocalUiServer({
    openCodeURL: `http://127.0.0.1:${upstream.address().port}`,
    token: "token",
    projectDirectory: root,
    port: 0,
  })
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    await new Promise((resolve, reject) => local.close((error) => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  })
  const origin = `http://127.0.0.1:${local.address().port}`
  const headers = { origin, "sec-fetch-site": "same-origin" }
  const loaded = await fetch(`${origin}/api/options`, { headers })
  assert.equal(loaded.status, 200)
  const current = await loaded.json()
  const applied = await fetch(`${origin}/api/options`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ revision: current.revision, options: { plans: { review: ["provider-a/new"] } } }),
  })
  assert.equal(applied.status, 200)
  assert.equal(await readFile(join(root, "opencode.json"), "utf8"), text)
  assert.match(await readFile(join(root, "quartermaster.jsonc"), "utf8"), /provider-a\/new/)
  assert.equal(await readFile(join(other, "opencode.json"), "utf8"), text)
  assert.equal(await readFile(join(other, "quartermaster.jsonc"), "utf8"), settingsText)
  const before = await readFile(join(root, "quartermaster.jsonc"), "utf8")
  const stale = await fetch(`${origin}/api/options`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ revision: 1, options: { plans: { review: ["provider-a/stale"] } } }),
  })
  assert.equal(stale.status, 409)
  assert.equal(await readFile(join(root, "opencode.json"), "utf8"), text)
  assert.equal(await readFile(join(root, "quartermaster.jsonc"), "utf8"), before)
  const denied = await fetch(`${origin}/api/options`, {
    method: "POST",
    headers: { origin: "http://attacker.invalid", "sec-fetch-site": "cross-site", "content-type": "application/json" },
    body: JSON.stringify({ revision: current.revision, options: { plans: { review: ["provider-a/stolen"] } } }),
  })
  assert.equal(denied.status, 403)
  assert.equal(await readFile(join(root, "opencode.json"), "utf8"), text)
  assert.equal(await readFile(join(root, "quartermaster.jsonc"), "utf8"), before)
  locationDirectory = other
  const previousReads = configReads
  assert.equal((await fetch(`${origin}/api/options`, { headers })).status, 409)
  assert.equal((await fetch(`${origin}/api/options`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ revision: current.revision, options: {} }),
  })).status, 400)
  assert.equal(configReads, previousReads, "wrong location never reaches configuration sources")
  assert.equal(await readFile(join(root, "opencode.json"), "utf8"), text)
  assert.equal(await readFile(join(root, "quartermaster.jsonc"), "utf8"), before)
  assert.equal(await readFile(join(other, "opencode.json"), "utf8"), text)
  assert.equal(await readFile(join(other, "quartermaster.jsonc"), "utf8"), settingsText)
})

test("local gateway rejects non-loopback upstreams and unsupported routes", () => {
  assert.throws(() => createLocalUiServer({
    openCodeURL: "http://localhost:4096", token: "token", projectDirectory: process.cwd(),
  }), /127\.0\.0\.1/)
  for (const suffix of ["/prefix", "?query=1", "#fragment"]) {
    assert.throws(() => createLocalUiServer({
      openCodeURL: `http://127.0.0.1:4096${suffix}`, token: "token", projectDirectory: process.cwd(),
    }), /without embedded credentials/)
  }
})

test("dashboard gateway exposes allowlisted provider metadata and cached quota despite report failure", async (t) => {
  const secret = "never-forward-this-secret"
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1")
    response.writeHead(200, { "content-type": "application/json" })
    if (url.pathname === "/api/location") return response.end(JSON.stringify(locationBody()))
    if (url.pathname === "/api/provider") return response.end(JSON.stringify({
      location: { directory: process.cwd(), project: { id: "project-a" } },
      data: [{ id: "demo", name: "Demo", options: { apiKey: secret }, headers: { authorization: secret } }],
    }))
    if (url.pathname === "/api/model") return response.end(JSON.stringify({
      location: { directory: process.cwd(), project: { id: "project-a" } },
      data: [{ id: "internal-row", modelID: "model-a", providerID: "demo", name: "Model A", enabled: true,
        limit: { context: 12000, input: 10000, output: 2000, secret: secret },
        capabilities: { tools: true, input: ["text", "image"], output: ["text"], temperature: false, headers: { key: secret } },
        cost: [
          { input: 0.000001, output: 0, cache: { read: 0, write: 0.000002 }, secret: secret },
          { input: 1.25, output: 2.5, cache: { read: 0.1, write: 0.2 }, tier: { type: "context", size: 128000, secret: secret } },
          { input: -1, output: 1, cache: { read: 1, write: 1 } },
          { input: 1, output: 1, cache: { read: 1, write: 1 }, tier: { type: "unknown", size: 10 } },
          { input: 1, output: 1, cache: { read: -1, write: 1 } },
          { input: null, output: 1, cache: { read: 1, write: 1 } },
        ], variants: [
          { id: "high reasoning", settings: { apiKey: secret }, headers: { authorization: secret }, body: { token: secret } },
          { id: "low" },
        ] },
        { id: "bad-optional", providerID: "demo", name: "Invalid optional metadata", limit: { context: -1, input: null, output: "bad" },
          capabilities: { tools: "yes", input: ["text", 1], output: null, temperature: 1 }, cost: [{ input: 1 }] }],
    }))
    if (url.pathname.endsWith("/status")) return response.end(JSON.stringify({ output: {
      ...plans, updatedAt: 111, reason: "cached status", failureCooldowns: [
        { providerID: "demo", until: 999, classification: "hidden" },
      ], sources: { demo: { sourceID: "codex", authenticated: true, checkedAt: 123, stale: false,
        availability: "limited", nextAvailableAt: 456, windows: [{ name: "weekly", usedPercent: 82,
          state: "rate-limited", resetsAt: 789, resetEstimated: true, token: secret }] } },
    } }))
    return response.end(JSON.stringify({ output: { status: "unavailable", reason: secret } }))
  })
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())))
  const local = createLocalUiServer({ openCodeURL: `http://127.0.0.1:${upstream.address().port}`, token: secret,
    projectDirectory: process.cwd(), port: 0 })
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve, reject) => local.close((error) => error ? reject(error) : resolve())))
  const origin = `http://127.0.0.1:${local.address().port}`
  const headers = { origin, "sec-fetch-site": "same-origin" }
  const catalogResponse = await fetch(`${origin}/api/providers`, { headers })
  assert.equal(catalogResponse.status, 200)
  const catalog = await catalogResponse.json()
  assert.equal(catalog.providers[0].models[0].name, "Model A")
  assert.deepEqual(catalog.providers[0].models[0], { id: "internal-row", name: "Model A", enabled: true,
    variants: ["high reasoning", "low"], context: 12000, input: 10000, output: 2000,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"], temperature: false },
    cost: [
      { input: 0.000001, output: 0, cache: { read: 0, write: 0.000002 } },
      { input: 1.25, output: 2.5, cache: { read: 0.1, write: 0.2 }, tier: { type: "context", size: 128000 } },
    ] })
  assert.deepEqual(catalog.providers[0].models[1], { id: "bad-optional", name: "Invalid optional metadata", variants: [] })
  assert.equal(JSON.stringify(catalog).includes(secret), false)
  const dashboardResponse = await fetch(`${origin}/api/dashboard`, { headers })
  assert.equal(dashboardResponse.status, 200)
  const dashboard = await dashboardResponse.json()
  assert.equal(dashboard.projectID, "project-a")
  assert.deepEqual(dashboard.plans, plans.plans)
  assert.deepEqual(dashboard.agents, plans.agents)
  assert.equal(dashboard.availability.updatedAt, 111)
  assert.equal(dashboard.availability.reason, "cached status")
  assert.deepEqual(dashboard.cooldowns, [{ providerID: "demo", until: 999 }])
  assert.equal(dashboard.report, null)
  assert.equal(dashboard.availability.sources.demo.windows[0].name, "weekly")
  assert.equal(JSON.stringify(dashboard).includes(secret), false)
})

test("provider catalog rejects malformed or cross-project model envelopes", async (t) => {
  let mode = "malformed"
  const upstream = createServer((request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname
    response.writeHead(200, { "content-type": "application/json" })
    if (path === "/api/location") return response.end(JSON.stringify(locationBody()))
    if (path === "/api/provider") return response.end(JSON.stringify({
      location: { directory: process.cwd(), project: { id: "project-a" } }, data: [{ id: "demo", name: "Demo" }],
    }))
    return response.end(JSON.stringify(mode === "malformed"
      ? { location: { directory: process.cwd(), project: { id: "project-a" } }, data: [{ id: "x", providerID: "demo" }] }
      : { location: { directory: process.cwd(), project: { id: "other-project" } }, data: [] }))
  })
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())))
  const local = createLocalUiServer({ openCodeURL: `http://127.0.0.1:${upstream.address().port}`, token: "token", projectDirectory: process.cwd(), port: 0 })
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve, reject) => local.close((error) => error ? reject(error) : resolve())))
  const origin = `http://127.0.0.1:${local.address().port}`
  const headers = { origin, "sec-fetch-site": "same-origin" }
  assert.equal((await fetch(`${origin}/api/providers`, { headers })).status, 502)
  mode = "cross-project"
  assert.equal((await fetch(`${origin}/api/providers`, { headers })).status, 502)
})

test("local gateway saves the winning settings file outside the project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qm-ui-project-"))
  const home = await mkdtemp(join(tmpdir(), "qm-ui-home-"))
  const registration = '{\n  "model": "keep",\n  "plugins": [{ "package": "quartermaster" }]\n}\n'
  const projectSettings = '{\n  "plans": { "review": ["provider-a/project"] }\n}\n'
  const outsideSettings = '{\n  "plans": { "review": ["provider-a/outside"] }\n}\n'
  await writeFile(join(root, "opencode.json"), registration)
  await writeFile(join(root, "quartermaster.jsonc"), projectSettings)
  await writeFile(join(home, "opencode.json"), registration)
  await writeFile(join(home, "quartermaster.jsonc"), outsideSettings)
  let pathless = false
  const sources = async () => pathless
    ? [{ type: "document", info: { plugins: [{ package: "quartermaster" }] } }]
    : [
      { type: "document", path: join(root, "opencode.json"), info: parseProjectConfig(registration) },
      { type: "document", path: join(home, "opencode.json"), info: parseProjectConfig(registration) },
    ]
  const upstream = createServer(async (request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    const path = new URL(request.url, "http://127.0.0.1").pathname
    if (path === "/api/config") response.end(JSON.stringify(await sources()))
    else response.end(JSON.stringify({ directory: root, project: { id: "project-a", directory: root } }))
  })
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())))
  const local = createLocalUiServer({
    openCodeURL: `http://127.0.0.1:${upstream.address().port}`, token: "token", projectDirectory: root, port: 0,
  })
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    await new Promise((resolve, reject) => local.close((error) => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })
  const origin = `http://127.0.0.1:${local.address().port}`
  const headers = { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }
  const loaded = await (await fetch(`${origin}/api/options`, { headers })).json()
  const pluginView = await readProjectQuartermasterOptions(root, sources)
  assert.equal(pluginView.writable, false)
  assert.equal(loaded.writable, true)
  assert.equal(loaded.path, pluginView.path)
  assert.deepEqual(loaded.options.plans.review, ["provider-a/outside"])
  await assert.rejects(() => applyProjectQuartermasterOptions({
    directory: root, revision: loaded.revision, options: { plans: { review: ["provider-a/plugin"] } }, readConfiguration: sources,
  }), /outside the writable project/)
  assert.equal(await readFile(join(home, "quartermaster.jsonc"), "utf8"), outsideSettings)
  const applied = await fetch(`${origin}/api/options`, {
    method: "POST", headers, body: JSON.stringify({ revision: loaded.revision, options: { plans: { review: ["provider-a/saved"] } } }),
  })
  assert.equal(applied.status, 200)
  const saved = await applied.json()
  assert.equal(saved.writable, true)
  assert.deepEqual(saved.options.plans.review, ["provider-a/saved"])
  assert.match(await readFile(join(home, "quartermaster.jsonc"), "utf8"), /provider-a\/saved/)
  assert.equal(await readFile(join(home, "quartermaster.jsonc.quartermaster.bak"), "utf8"), outsideSettings)
  assert.equal(await readFile(join(root, "quartermaster.jsonc"), "utf8"), projectSettings)
  assert.equal(await readFile(join(root, "opencode.json"), "utf8"), registration)
  assert.equal(await readFile(join(home, "opencode.json"), "utf8"), registration)
  const stale = await fetch(`${origin}/api/options`, {
    method: "POST", headers, body: JSON.stringify({ revision: loaded.revision, options: { plans: { review: ["provider-a/stale"] } } }),
  })
  assert.equal(stale.status, 409)
  assert.match(await readFile(join(home, "quartermaster.jsonc"), "utf8"), /provider-a\/saved/)
  pathless = true
  const readonly = await (await fetch(`${origin}/api/options`, { headers })).json()
  assert.equal(readonly.writable, false)
  assert.equal(readonly.path, undefined)
  const refused = await fetch(`${origin}/api/options`, {
    method: "POST", headers, body: JSON.stringify({ revision: readonly.revision, options: { plans: { review: ["provider-a/created"] } } }),
  })
  assert.equal(refused.status, 409)
  assert.match(await readFile(join(home, "quartermaster.jsonc"), "utf8"), /provider-a\/saved/)
})

test("plugin startup leaves a busy local UI port alone and stops the process it starts", async () => {
  assert.equal(localUiListenError({ code: "EADDRINUSE" }), "running")
  assert.equal(localUiListenError({ code: "EACCES" }), "error")
  assert.equal(shouldOpenLocalUiBrowser({}), true)
  assert.equal(shouldOpenLocalUiBrowser({ QUARTERMASTER_LOCAL_UI_OPEN_BROWSER: "0" }), false)

  const directory = process.cwd()
  const env = { QUARTERMASTER_LOCAL_UI_PORT: "43111" }
  let spawned = 0
  const seen = []
  const spawnImpl = (exe, args, options) => {
    spawned += 1
    const child = {
      killed: false,
      exitCode: null,
      kill() { this.killed = true },
      unref() {},
      stderr: { setEncoding() {}, on() {}, unref() {} },
    }
    seen.push({ exe, args, options, child })
    return child
  }
  assert.equal(await ensureLocalUi({
    projectDirectory: "  ", env, spawnImpl, connect: async () => { throw new Error("probed") },
  }), "skipped")
  assert.equal(await ensureLocalUi({
    projectDirectory: directory,
    env: { ...env, QUARTERMASTER_LOCAL_UI: "0" },
    spawnImpl,
    connect: async () => { throw new Error("probed") },
  }), "disabled")
  let adopted = false
  assert.equal(await ensureLocalUi({
    projectDirectory: directory, env, spawnImpl, connect: async () => true,
    retain() { adopted = true },
  }), "running")
  assert.equal(spawned, 0)
  assert.equal(adopted, false)
  assert.equal(localUiOwnerCount(), 0)

  let probes = 0
  let stop
  let extraStop
  try {
    const started = ensureLocalUi({
      projectDirectory: directory,
      env,
      scriptPath: "src/local-ui.mjs",
      attempts: 3,
      sleep: async () => {},
      connect: async (port) => {
        assert.equal(port, 43111)
        probes += 1
        return probes > 1
      },
      retain(fn) { stop = fn },
      spawnImpl,
    })
    const shared = ensureLocalUi({
      projectDirectory: directory,
      env,
      spawnImpl: () => { throw new Error("second spawn") },
      connect: async () => { throw new Error("second probe") },
    })
    assert.equal(shared, started)
    assert.equal(await started, "started")
    assert.equal(spawned, 1)
    assert.equal(probes, 2)
    const child = seen[0]
    assert.equal(child.exe, process.execPath)
    assert.deepEqual(child.args, ["src/local-ui.mjs"])
    assert.equal(child.options.detached, false)
    assert.equal(child.options.windowsHide, true)
    assert.equal(child.options.cwd, resolve(directory))
    assert.equal(child.options.env.QUARTERMASTER_PROJECT_DIR, resolve(directory))
    assert.equal(child.options.env.QUARTERMASTER_GATEWAY_CHILD, "1")
    assert.equal(child.options.env.QUARTERMASTER_LOCAL_UI_OPEN_BROWSER, "0")
    assert.equal(child.options.env.QUARTERMASTER_LOCAL_UI_PARENT_PID, String(process.pid))
    assert.deepEqual(child.options.stdio, ["ignore", "ignore", "pipe"])
    assert.equal(localUiOwnerCount(), 1)

    assert.equal(await ensureLocalUi({
      projectDirectory: directory,
      env,
      connect: async () => true,
      spawnImpl: () => { throw new Error("owned spawn") },
      retain(fn) { extraStop = fn },
    }), "running")
    assert.equal(localUiOwnerCount(), 2)
    extraStop()
    assert.equal(child.child.killed, false)
    assert.equal(localUiOwnerCount(), 1)
    stop()
    assert.equal(child.child.killed, true)
    assert.equal(localUiOwnerCount(), 0)

    await assert.rejects(() => ensureLocalUi({
      projectDirectory: directory,
      env: { QUARTERMASTER_LOCAL_UI_PORT: "0" },
      spawnImpl,
      connect: async () => false,
    }), /Invalid local UI port/)
    await assert.rejects(() => ensureLocalUi({
      projectDirectory: directory,
      env,
      attempts: 2,
      sleep: async () => {},
      connect: async () => false,
      spawnImpl: () => ({
        unref() {},
        stderr: {
          setEncoding() {},
          on(event, callback) { if (event === "data") callback("port closed\n") },
          unref() {},
        },
      }),
    }), /port closed/)
  } finally {
    extraStop?.()
    stop?.()
  }
})

test("local UI parent watch stops when the parent is gone", async () => {
  assert.equal(watchLocalUiParent(0), undefined)
  assert.equal(watchLocalUiParent(process.pid), undefined)
  let immediate = 0
  const stopNow = watchLocalUiParent(4321, { isAlive: () => false, onGone: () => { immediate += 1 } })
  assert.equal(immediate, 1)
  stopNow?.()
  assert.equal(immediate, 1)

  let alive = true
  let gone = 0
  const stop = watchLocalUiParent(4321, {
    isAlive: () => alive,
    onGone: () => { gone += 1 },
    intervalMs: 15,
  })
  assert.equal(gone, 0)
  alive = false
  await new Promise((done) => setTimeout(done, 50))
  assert.equal(gone, 1)
  stop?.()
  await new Promise((done) => setTimeout(done, 40))
  assert.equal(gone, 1)
})
