import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { createLocalUiServer } from "../src/local-ui.mjs"

test("gateway forwards well-formed quota estimates and drops malformed ones without blanking the window", async (t) => {
  const secret = "never-forward-this-secret"
  const plans = {
    apiVersion: 1,
    status: "ok",
    updatedAt: 111,
    plans: { local: ["demo/model"] },
    agents: { "qm-test": "local" },
    workTypes: {},
    sources: {
      demo: {
        sourceID: "codex",
        authenticated: true,
        checkedAt: 123,
        stale: false,
        availability: "available",
        nextAvailableAt: null,
        windows: [
          { name: "weekly", usedPercent: 50, state: "ok", resetsAt: 12_345, resetEstimated: true,
            apiValue: { currency: "USD", basis: "api-equivalent-not-billed", observedUSD: 12.5,
              projectedFullUSD: 250, projectionStatus: "estimated", reason: null,
              trackingSince: 123, observedAt: 1_200_123, spanMs: 1_200_000, quotaDeltaPercent: 10,
              records: 4, pricedRecords: 4, unpricedRecords: 0, partialRecords: 0, complete: false,
              secret: "never-forward-this-secret" },
            estimate: { status: "estimated", cutoffPercent: 90, sampleCount: 3, spanMs: 1_200_000, ratePerMinute: 0.5, cutoffAt: 999_999 } },
          { name: "daily", usedPercent: 60, state: "ok", resetsAt: null,
            apiValue: { currency: "USD", basis: "api-equivalent-not-billed", observedUSD: 1,
              projectedFullUSD: null, projectionStatus: "estimated", reason: null,
              trackingSince: 123, observedAt: 1_200_123, spanMs: 1_200_000, quotaDeltaPercent: 10,
              records: 1, pricedRecords: 1, unpricedRecords: 0, partialRecords: 0, complete: false },
            estimate: { status: "estimated", cutoffPercent: 90, sampleCount: 2, spanMs: 0, ratePerMinute: -1, cutoffAt: "soon", token: secret } },
          { name: "hourly", usedPercent: 20, state: "ok", resetsAt: null,
            apiValue: { currency: "USD", basis: "api-equivalent-not-billed", observedUSD: 0,
              projectedFullUSD: 0, projectionStatus: "estimated", reason: null,
              trackingSince: 123, observedAt: 1_200_123, spanMs: 1_200_000, quotaDeltaPercent: 10,
              records: 1, pricedRecords: 1, unpricedRecords: 0, partialRecords: 0, complete: false,
              token: secret },
            estimate: { status: "invented", cutoffPercent: 90, sampleCount: 1, spanMs: 0 } },
          { name: "monthly", usedPercent: 10, state: "ok", resetsAt: null,
            estimate: { status: "no-recent-usage", cutoffPercent: 90, sampleCount: 2, spanMs: 900_000 } },
          { name: "bad-sample", usedPercent: 30, state: "ok", resetsAt: null,
            estimate: { status: "estimated", cutoffPercent: 90, sampleCount: 1, spanMs: 1_200_000, ratePerMinute: 0.5, cutoffAt: 123 } },
          { name: "bad-span", usedPercent: 30, state: "ok", resetsAt: null,
            estimate: { status: "estimated", cutoffPercent: 90, sampleCount: 2, spanMs: 899_999, ratePerMinute: 0.5, cutoffAt: 123 } },
          { name: "bad-cutoff", usedPercent: 30, state: "ok", resetsAt: null,
            estimate: { status: "estimated", cutoffPercent: 101, sampleCount: 2, spanMs: 900_000, ratePerMinute: 0.5, cutoffAt: 123 } },
          { name: "bad-timestamp", usedPercent: 30, state: "ok", resetsAt: null,
            estimate: { status: "no-recent-usage", cutoffPercent: 90, sampleCount: 2, spanMs: 900_000, cutoffAt: -1 } },
          { name: "bad-api-unpriced", usedPercent: 30, state: "ok", resetsAt: null,
            apiValue: { currency: "USD", basis: "api-equivalent-not-billed", observedUSD: 1,
              projectedFullUSD: 10, projectionStatus: "estimated", reason: null,
              trackingSince: 123, observedAt: 1_200_123, spanMs: 1_200_000, quotaDeltaPercent: 10,
              records: 2, pricedRecords: 1, unpricedRecords: 1, partialRecords: 0, complete: false } },
          { name: "bad-api-null", usedPercent: 31, state: "ok", resetsAt: null,
            apiValue: { currency: "USD", basis: "api-equivalent-not-billed", observedUSD: null,
              projectedFullUSD: 10, projectionStatus: "estimated", reason: null,
              trackingSince: 123, observedAt: 1_200_123, spanMs: 1_200_000, quotaDeltaPercent: 10,
              records: 1, pricedRecords: 1, unpricedRecords: 0, partialRecords: 0, complete: false } },
          { name: "bad-api-shape", usedPercent: 32, state: "ok", resetsAt: null,
            apiValue: { currency: "USD", basis: "api-equivalent-not-billed", observedUSD: 1,
              projectedFullUSD: 10, projectionStatus: "estimated", reason: null,
              trackingSince: 123, observedAt: 1_200_123, spanMs: 1_200_000, quotaDeltaPercent: 10,
              records: 1, pricedRecords: 1, unpricedRecords: 0, partialRecords: 0 } },
          { name: "bad-api-reason", usedPercent: 33, state: "ok", resetsAt: null,
            apiValue: { currency: "USD", basis: "api-equivalent-not-billed", observedUSD: null,
              projectedFullUSD: null, projectionStatus: "unavailable", reason: "  padded  ",
              trackingSince: 123, observedAt: 1_200_123, spanMs: 1_200_000, quotaDeltaPercent: 10,
              records: 0, pricedRecords: 0, unpricedRecords: 0, partialRecords: 0, complete: false } },
          { name: "bad-api-safeint", usedPercent: 34, state: "ok", resetsAt: null,
            apiValue: { currency: "USD", basis: "api-equivalent-not-billed", observedUSD: null,
              projectedFullUSD: null, projectionStatus: "unavailable", reason: "API prices unavailable",
              trackingSince: 123, observedAt: 1_200_123.5, spanMs: 1_200_000.5, quotaDeltaPercent: 10,
              records: 0, pricedRecords: 0, unpricedRecords: 0, partialRecords: 0, complete: false } },
        ],
      },
    },
  }
  const upstream = createServer((request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname
    response.writeHead(200, { "content-type": "application/json" })
    if (path === "/api/location") return response.end(JSON.stringify({
      directory: process.cwd(), project: { id: "project-a", directory: process.cwd() },
    }))
    if (path === "/api/project") return response.end(JSON.stringify({
      data: [{ id: "project-a", canonical: process.cwd() }],
    }))
    if (path.endsWith("/status")) return response.end(JSON.stringify({ output: plans }))
    return response.end(JSON.stringify({ output: null }))
  })
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())))
  const local = createLocalUiServer({
    openCodeURL: `http://127.0.0.1:${upstream.address().port}`,
    token: "server-only-test-token",
    projectDirectory: process.cwd(),
    port: 0,
  })
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve, reject) => local.close((error) => error ? reject(error) : resolve())))
  const origin = `http://127.0.0.1:${local.address().port}`
  const headers = { origin, "sec-fetch-site": "same-origin" }

  const response = await fetch(`${origin}/api/dashboard`, { headers })
  assert.equal(response.status, 200)
  const dashboard = await response.json()
  const windows = dashboard.availability.sources.demo.windows
  assert.deepEqual(windows[0].estimate, {
    status: "estimated", cutoffPercent: 90, sampleCount: 3, spanMs: 1_200_000, ratePerMinute: 0.5, cutoffAt: 999_999,
  })
  assert.deepEqual(windows[0].apiValue, {
    currency: "USD", basis: "api-equivalent-not-billed", observedUSD: 12.5,
    projectedFullUSD: 250, projectionStatus: "estimated", reason: null,
    trackingSince: 123, observedAt: 1_200_123, spanMs: 1_200_000, quotaDeltaPercent: 10,
    records: 4, pricedRecords: 4, unpricedRecords: 0, partialRecords: 0, complete: false,
  })
  // A contradictory api value is dropped; the window itself stays.
  assert.equal(windows[1].apiValue, undefined)
  assert.deepEqual(windows[2].apiValue, {
    currency: "USD", basis: "api-equivalent-not-billed", observedUSD: 0,
    projectedFullUSD: 0, projectionStatus: "estimated", reason: null,
    trackingSince: 123, observedAt: 1_200_123, spanMs: 1_200_000, quotaDeltaPercent: 10,
    records: 1, pricedRecords: 1, unpricedRecords: 0, partialRecords: 0, complete: false,
  })
  for (const index of [8, 9, 10, 11, 12]) {
    assert.equal(windows[index].usedPercent, 30 + index - 8)
    assert.equal(windows[index].apiValue, undefined)
  }
  // Malformed forecasts disappear; the good quota snapshot stays.
  assert.equal(windows[1].usedPercent, 60)
  assert.equal(windows[1].estimate, undefined)
  assert.equal(windows[2].usedPercent, 20)
  assert.equal(windows[2].estimate, undefined)
  assert.deepEqual(windows[3].estimate, { status: "no-recent-usage", cutoffPercent: 90, sampleCount: 2, spanMs: 900_000 })
  for (const index of [4, 5, 6, 7]) {
    assert.equal(windows[index].usedPercent, 30)
    assert.equal(windows[index].estimate, undefined)
  }
  assert.equal(JSON.stringify(dashboard).includes(secret), false)
})
