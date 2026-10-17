import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createLocalUiServer } from "../src/local-ui.mjs"
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
