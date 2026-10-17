import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { Service } from "@opencode/client/service"
import { readNativeConfiguration } from "../src/project-options.ts"

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
