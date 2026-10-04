import assert from "node:assert/strict"
import { createServer, type RequestListener, type Server } from "node:http"
import test from "node:test"
import type { ModelRef } from "../src/config.ts"
import { applyLocalHealth, LocalHealth } from "../src/local-health.ts"
import { modelKey, selectModel, type ModelEligibility } from "../src/select.ts"

async function listen(handler: RequestListener) {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return { server, url: `http://127.0.0.1:${address.port}/health` }
}

async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

test("local checks are isolated, cached, and restore the primary after recovery", async (t) => {
  let localOnline = false
  let secondOnline = true
  const requests: string[] = []
  const makeHandler = (name: string, isOnline: () => boolean) => (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => {
    requests.push(`${name}:${request.method}:${request.headers.authorization ?? ""}`)
    response.writeHead(isOnline() ? 200 : 503)
    response.end()
  }
  const first = await listen(makeHandler("first", () => localOnline))
  const second = await listen(makeHandler("second", () => secondOnline))
  t.after(() => Promise.all([close(first.server), close(second.server)]))

  const models: ModelRef[] = [
    { providerID: "local-a", modelID: "model" },
    { providerID: "local-b", modelID: "model" },
    { providerID: "remote", modelID: "model" },
  ]
  const plan = [models[0]!, models[2]!]
  const base = new Map<string, ModelEligibility>(models.map((model) => [modelKey(model), { status: "available" }]))
  const health = new LocalHealth({ "local-a": first.url, "local-b": second.url }, 1000, fetch, 100)

  const initial = await health.checkAll(models.map((model) => model.providerID), { now: 0 })
  assert.deepEqual([...initial], [["local-a", "offline"], ["local-b", "online"]])
  let eligibility = applyLocalHealth(models, base, initial)
  let result = selectModel(plan, models, eligibility, 0)
  assert.equal(result.status, "selected")
  if (result.status === "selected") {
    assert.equal(result.model.providerID, "remote")
    assert.deepEqual(result.skipped, [{ model: models[0], reason: { code: "local-offline" } }])
  }
  assert.deepEqual([...requests].sort(), ["first:GET:", "second:GET:"])

  localOnline = true
  const cached = await health.check("local-a", { now: 99 })
  assert.equal(cached, "offline")
  assert.equal(requests.length, 2)

  const recovered = await health.checkAll(models.map((model) => model.providerID), { now: 100 })
  assert.equal(recovered.get("local-a"), "online")
  eligibility = applyLocalHealth(models, base, recovered)
  result = selectModel(plan, models, eligibility, 100)
  assert.equal(result.status, "selected")
  if (result.status === "selected") assert.equal(result.model.providerID, "local-a")
  assert.equal(requests.filter((entry) => entry.startsWith("first:")).length, 2)
  assert.equal(secondOnline, true)
})

test("a timed-out configured endpoint is marked offline", async (t) => {
  let requests = 0
  const pending = await listen(() => { requests++ })
  t.after(() => close(pending.server))

  const health = new LocalHealth({ local: pending.url }, 25)
  assert.equal(await health.check("local"), "offline")
  assert.equal(requests, 1)
})

test("toString is probed only when explicitly configured", async () => {
  const endpoint = "http://127.0.0.1:12345/health"
  const requests: Parameters<typeof fetch>[0][] = []
  const fetcher: typeof fetch = async (input) => {
    requests.push(input)
    return new Response(null, { status: 200 })
  }
  const unconfigured = new LocalHealth({}, 10, fetcher)
  assert.equal(await unconfigured.check("toString"), undefined)
  assert.equal((await unconfigured.checkAll(["toString"])).size, 0)
  assert.equal(requests.length, 0)

  const configured = new LocalHealth({ toString: endpoint }, 10, fetcher)
  assert.equal(await configured.check("toString", { now: 0 }), "online")
  assert.equal((await configured.checkAll(["toString"], { now: 1 })).get("toString"), "online")
  assert.deepEqual(requests, [endpoint])
})

test("unconfigured remote providers are never probed or filtered", async () => {
  const remote: ModelRef = { providerID: "remote", modelID: "hosted" }
  const eligibility = applyLocalHealth(
    [remote],
    new Map([[modelKey(remote), { status: "available" }]]),
    await new LocalHealth({}, 10).checkAll([remote.providerID]),
  )
  assert.deepEqual(selectModel([remote], [remote], eligibility, 0), {
    status: "selected",
    model: remote,
    reason: { code: "highest-priority-eligible" },
    skipped: [],
  })
})
