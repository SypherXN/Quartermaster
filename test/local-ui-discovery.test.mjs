import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"
import { createLocalUiServer } from "../src/local-ui.mjs"

async function listen(server) {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return `http://127.0.0.1:${server.address().port}`
}

test("UI rediscovers host address and authentication without restarting", async (t) => {
  const directory = process.cwd()
  async function host(password, records) {
    const server = createServer((req, res) => {
      assert.equal(req.headers.authorization, `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`)
      const path = new URL(req.url, "http://127.0.0.1").pathname
      assert.equal(new URL(req.url, "http://127.0.0.1").searchParams.get("location[directory]"), directory)
      // OpenCode scopes RPC dispatch by this header; without it another project's host answers.
      assert.equal(req.headers["x-opencode-directory"], directory)
      const body = path === "/api/location" ? { directory, project: { id: "project" } }
        : path.endsWith("/report") ? { output: { apiVersion: 1, status: "ok", projectID: "project", totals: { records }, costs: {} } }
        : { output: { apiVersion: 1, plans: {}, agents: {}, workTypes: {} } }
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(body))
    })
    const url = await listen(server)
    t.after(() => new Promise((done) => server.close(done)))
    return { url, auth: { type: "basic", username: "opencode", password } }
  }
  const first = await host("fake-first", 1)
  const second = await host("fake-second", 2)
  let current = first
  const ui = createLocalUiServer({ projectDirectory: directory, port: 0, resolveEndpoint: async () => current })
  const origin = await listen(ui)
  t.after(() => new Promise((done) => ui.close(done)))
  async function report() {
    return fetch(`${origin}/api/report`, { headers: { origin, "sec-fetch-site": "same-origin" } })
  }
  assert.equal((await (await report()).json()).totals.records, 1)
  current = undefined
  assert.equal((await report()).status, 502)
  current = second
  assert.equal((await (await report()).json()).totals.records, 2)
  // Do not send credentials to a non-loopback discovered origin.
  current = { ...second, url: "https://example.com" }
  assert.equal((await report()).status, 502)
})

test("UI exposes upstream HTTP status without response bodies or credentials", async (t) => {
  const host = createServer((_req, res) => {
    res.writeHead(401).end("private response must not escape")
  })
  const url = await listen(host)
  t.after(() => new Promise((done) => host.close(done)))
  const ui = createLocalUiServer({ projectDirectory: process.cwd(), port: 0,
    resolveEndpoint: async () => ({ url }) })
  const origin = await listen(ui)
  t.after(() => new Promise((done) => ui.close(done)))
  const response = await fetch(`${origin}/api/options`, { headers: { origin, "sec-fetch-site": "same-origin" } })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: "OpenCode /api/location returned HTTP 401 (no credentials supplied)" })
})
