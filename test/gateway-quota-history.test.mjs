import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { createLocalUiServer } from "../src/local-ui.mjs"

const value = (over = {}) => ({
  currency: "USD", basis: "api-equivalent-not-billed", observedUSD: 2.5, projectedFullUSD: null,
  projectionStatus: "unavailable", reason: "Too little history", trackingSince: 1_000, observedAt: 2_000, spanMs: 1_000,
  quotaDeltaPercent: 2, records: 2, pricedRecords: 2, unpricedRecords: 0, partialRecords: 0, complete: false, ...over,
})
const unpriced = value({ observedUSD: null, records: 1, pricedRecords: 0, unpricedRecords: 1 })
const point = (observedAt, apiValue, over = {}) => ({
  observedAt, percent: 10, state: "ok", resetsAt: 9_999, resetEstimated: false, cycleBoundary: false,
  estimate: { status: "no-recent-usage", cutoffPercent: 90, sampleCount: 2, spanMs: 900_000 },
  ...(apiValue ? { apiValue } : {}), ...over,
})
const windowRow = (over = {}) => ({
  version: 1, sourceID: "codex", windowName: "weekly", lastObservedAt: 2_000, nextObservedAt: 3_000,
  lastPercent: 90, nextPercent: 10, resetsAt: null, resetEstimated: false, nextResetsAt: null,
  deadlineCrossed: false, ...over,
})

async function harness(t, handler) {
  const seen = []
  const upstream = createServer(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname
    response.writeHead(path.endsWith("/quotaHistory") && handler.status ? handler.status : 200, { "content-type": "application/json" })
    if (path === "/api/location") return response.end(JSON.stringify({ directory: process.cwd(), project: { id: "p", directory: process.cwd() } }))
    if (path.endsWith("/status")) return response.end(JSON.stringify({ output: {
      apiVersion: 1, plans: {}, agents: {}, workTypes: {}, sources: {},
    } }))
    if (path.endsWith("/quotaHistory")) {
      let body = ""
      for await (const chunk of request) body += chunk
      seen.push(JSON.parse(body).input)
      return response.end(JSON.stringify({ output: handler.output }))
    }
    return response.end(JSON.stringify({ output: null }))
  })
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())))
  const local = createLocalUiServer({
    openCodeURL: `http://127.0.0.1:${upstream.address().port}`, token: "server-only-test-token",
    projectDirectory: process.cwd(), port: 0,
  })
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve, reject) => local.close((error) => error ? reject(error) : resolve())))
  const origin = `http://127.0.0.1:${local.address().port}`
  const get = (query) => fetch(`${origin}/api/quota-history?${query}`, { headers: { origin, "sec-fetch-site": "same-origin" } })
  return { get, seen, dashboard: () => fetch(`${origin}/api/dashboard`) }
}

test("quota history returns a narrowed payload and preserves null observedUSD", async (t) => {
  const { get, seen } = await harness(t, { output: {
    status: "ok", catalog: [{ sourceID: "codex" }], nextCatalogCursor: "x",
    points: [point(1_000, value()), point(2_000, unpriced, { cycleBoundary: true })],
    nextCursor: "2000",
    cumulative: { sourceID: "codex", windowName: "weekly", observations: 5, cycleBoundaries: 1, firstObservedAt: 1, lastObservedAt: 2, secret: "x",
      apiValue: { basis: "closed-reset-segments-only", apiValuePoints: 3, unpricedApiValuePoints: 1, estimatedProjections: 0,
        projectedMinUSD: null, projectedMaxUSD: null, closedResetSegments: 1, closedObservedUSD: 4, closedObservedUSDComplete: false, maxedSnapshots: 0 } },
    metadata: { rawRetentionMs: 100, rawSince: 5, pageSize: 200, pointScope: "x" },
  } })
  const response = await get("sourceID=codex&windowName=weekly&limit=5000&from=1&to=9")
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(seen[0], { sourceID: "codex", windowName: "weekly", from: 1, to: 9, limit: 1000 })
  assert.equal(body.status, "ok")
  assert.equal(body.dropped, 0)
  assert.equal(body.nextCursor, "2000")
  assert.equal(body.points.length, 2)
  assert.deepEqual(body.points[0], { observedAt: 1_000, percent: 10, resetsAt: 9_999, cycleBoundary: false, apiValue: value() })
  assert.equal(body.points[1].apiValue.observedUSD, null)
  assert.notEqual(body.points[1].apiValue.observedUSD, 0)
  assert.equal(body.points[1].cycleBoundary, true)
  for (const item of body.points) for (const key of ["estimate", "state", "resetEstimated"]) assert.equal(key in item, false)
  assert.equal("catalog" in body, false)
  assert.equal(body.cumulative.apiValue.closedObservedUSD, 4)
  assert.equal("secret" in body.cumulative, false)
  assert.deepEqual(body.metadata, { rawRetentionMs: 100, rawSince: 5, pageSize: 200 })
})

test("quota history drops malformed points and values, counts them, and still answers 200", async (t) => {
  const { get } = await harness(t, { output: {
    status: "ok", nextCursor: null, cumulative: null,
    points: [
      point(1_000, value()),
      { observedAt: "bad", percent: 1 },
      null,
      point(3_000, value({ observedUSD: 1, pricedRecords: 0, unpricedRecords: 2 })),
      point(4_000, value(), { apiValueSnapshots: [{ event: "reset", segmentID: "s1", capturedAt: 3_900, value: value() }, { event: "nope", segmentID: "s", capturedAt: 1, value: value() }] }),
    ],
  } })
  const response = await get("sourceID=codex&windowName=weekly")
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.points.map((item) => item.observedAt), [1_000, 3_000, 4_000])
  assert.equal("apiValue" in body.points[1], false)
  assert.equal(body.points[2].apiValueSnapshots.length, 1)
  assert.equal(body.dropped, 4)
  assert.equal(body.cumulative, null)
})

test("quota history rejects bad input with 400 before calling upstream", async (t) => {
  const { get, seen } = await harness(t, { output: { status: "ok", points: [], nextCursor: null, cumulative: null } })
  for (const query of [
    "windowName=weekly", "sourceID=&windowName=weekly", `sourceID=${"a".repeat(129)}&windowName=weekly`,
    "sourceID=a%00b&windowName=weekly", "sourceID=codex&windowName=weekly&extra=1",
    "sourceID=codex&windowName=weekly&from=1.5", "sourceID=codex&windowName=weekly&from=abc",
    "sourceID=codex&windowName=weekly&limit=0", `sourceID=codex&windowName=weekly&cursor=${"1".repeat(65)}`,
    "sourceID=codex&windowName=weekly&cursor=abc", "sourceID=codex&windowName=weekly&cursor=01",
    "sourceID=codex&sourceID=go&windowName=weekly",
    "kind=other&sourceID=codex&windowName=weekly", "kind=&sourceID=codex&windowName=weekly",
    "kind=windows&sourceID=codex", "kind=windows&kind=points&sourceID=codex&windowName=weekly",
  ]) {
    const response = await get(query)
    assert.equal(response.status, 400, query)
    const body = await response.json()
    assert.equal(typeof body.error, "string")
  }
  assert.equal(seen.length, 0)
})

test("closed windows are narrowed, preserving inferred boundaries and unknown values", async (t) => {
  const estimate = value({ projectionStatus: "estimated", reason: null, projectedFullUSD: 10, observedAt: 901_000, spanMs: 900_000, quotaDeltaPercent: 10 })
  // Clock-coherent with lastObservedAt 901_000: observedAt - trackingSince === spanMs.
  const aged = value({ observedAt: 901_000, trackingSince: 900_000 })
  const unpricedAged = value({ observedUSD: null, records: 1, pricedRecords: 0, unpricedRecords: 1, observedAt: 901_000, trackingSince: 900_000 })
  const { get, seen } = await harness(t, { output: {
    status: "ok", points: [point(2_000, value())], catalog: [{ secret: "x" }], cumulative: { observations: 9 },
    windows: [windowRow({ lastObservedAt: 901_000, nextObservedAt: 902_000, apiValue: { ...unpricedAged, secret: "x" }, maxed: { capturedAt: 901_000, value: { ...aged, secret: "x" }, secret: "x" }, finalEstimate: { ...estimate, boundaryPoint: { private: true }, secret: "x" }, secret: "x" }),
      windowRow({ deadlineCrossed: true, resetsAt: 2_500, resetEstimated: true, apiValue: unpriced })],
    nextCursor: "2000", metadata: { rawRetentionMs: 100, rawSince: 5, pageSize: 2, rangeAppliesTo: "windows", closedRetention: "indefinite", secret: "x" },
  } })
  const response = await get("kind=windows&sourceID=codex&windowName=weekly&from=1&to=3000&cursor=1&limit=2")
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(seen[0], { kind: "windows", sourceID: "codex", windowName: "weekly", from: 1, to: 3000, cursor: "1", limit: 2 })
  // An unavailable window exposes its last durable value as the frozen outcome, so
  // the pane can show the truthful reason; only `estimated` rows carry an amount.
  assert.deepEqual(body.windows, [windowRow({ lastObservedAt: 901_000, nextObservedAt: 902_000, apiValue: unpricedAged, maxed: { capturedAt: 901_000, value: aged }, finalEstimate: estimate }),
    windowRow({ deadlineCrossed: true, resetsAt: 2_500, resetEstimated: true, apiValue: unpriced, finalEstimate: unpriced })])
  assert.equal(body.windows[0].apiValue.observedUSD, null)
  assert.equal(body.windows[0].finalEstimate.projectedFullUSD, 10)
  assert.equal(body.windows[1].finalEstimate.projectedFullUSD, null)
  assert.equal(body.windows[1].finalEstimate.reason, "Too little history")
  assert.equal("boundaryPoint" in body.windows[0].finalEstimate, false)
  assert.deepEqual(body.points, [])
  assert.equal(body.cumulative, null)
  assert.equal("catalog" in body, false)
  assert.equal(body.nextCursor, "2000")
  assert.equal(body.dropped, 0)
  assert.deepEqual(body.metadata, { rawRetentionMs: 100, rawSince: 5, pageSize: 2, rangeAppliesTo: "windows", closedRetention: "indefinite" })
})

test("closed windows drop malformed rows and optional values independently", async (t) => {
  const estimated = value({ projectionStatus: "estimated", reason: null, projectedFullUSD: 10, observedAt: 901_000, spanMs: 900_000, quotaDeltaPercent: 10 })
  const { get } = await harness(t, { output: { status: "ok", points: [], windows: [
    windowRow({ nextObservedAt: 2_000 }), windowRow({ deadlineCrossed: true, resetsAt: 2_000 }),
    windowRow({ nextPercent: 90 }), windowRow({ sourceID: "other" }),
    windowRow({ apiValue: value({ observedAt: 1_999 }), maxed: { capturedAt: 2_001, value: value() } }),
    windowRow({ maxed: { capturedAt: 1_999, value: value() } }),
    windowRow({ apiValue: value({ pricedRecords: 0 }) }),
    windowRow({ lastObservedAt: 901_000, nextObservedAt: 902_000, finalEstimate: estimated }),
    windowRow({ lastObservedAt: 901_000, nextObservedAt: 902_000, finalEstimate: { ...estimated, observedAt: 902_000 } }),
    windowRow({ finalEstimate: { ...estimated, projectionStatus: "unavailable" } }),
    windowRow({ finalEstimate: { ...estimated, projectedFullUSD: null } }),
    windowRow({ lastObservedAt: 901_000, nextObservedAt: 902_000, finalEstimate: { ...estimated, observedAt: 0 } }),
  ], nextCursor: null } })
  const response = await get("kind=windows&sourceID=codex&windowName=weekly")
  const body = await response.json()
  assert.equal(response.status, 200)
  // Rows 1-4 are dropped at the core. Rows 5-12 are kept with their core fields;
  // only the bad optional payloads are stripped (counted as 8 in `bad`).
  assert.deepEqual(body.windows, [
    windowRow({ finalEstimateReason: "No estimate recorded" }),
    windowRow({ finalEstimateReason: "No estimate recorded" }),
    windowRow({ finalEstimateReason: "No estimate recorded" }),
    windowRow({ lastObservedAt: 901_000, nextObservedAt: 902_000, finalEstimate: estimated }),
    windowRow({ lastObservedAt: 901_000, nextObservedAt: 902_000, finalEstimateReason: "No estimate recorded" }),
    windowRow({ finalEstimateReason: "No estimate recorded" }),
    windowRow({ finalEstimateReason: "No estimate recorded" }),
    windowRow({ lastObservedAt: 901_000, nextObservedAt: 902_000, finalEstimateReason: "No estimate recorded" }),
  ])
  assert.equal(body.windows.length, 8)
  assert.equal(body.dropped, 12)
})

test("a page cursor is exclusive and never echoes backwards", async (t) => {
  const { get, seen } = await harness(t, { output: { status: "ok", points: [], windows: [], nextCursor: "5" } })
  // Upstream repeating the request cursor would make a refresh re-read and duplicate.
  const repeated = await get("kind=windows&sourceID=codex&windowName=weekly&cursor=5")
  assert.equal(repeated.status, 200)
  assert.equal((await repeated.json()).nextCursor, null)
  assert.equal(seen[0].cursor, "5")
  const forward = await harness(t, { output: { status: "ok", points: [], windows: [], nextCursor: "9" } })
  const page = await forward.get("kind=windows&sourceID=codex&windowName=weekly&cursor=5")
  assert.equal((await page.json()).nextCursor, "9")
})

test("explicit points remains compatible and malformed windows response fails closed", async (t) => {
  const handler = { output: { status: "ok", points: [point(2_000, value())], nextCursor: null } }
  const { get, seen } = await harness(t, handler)
  assert.equal((await get("kind=points&sourceID=codex&windowName=weekly")).status, 200)
  assert.equal(seen[0].kind, "points")
  const response = await get("kind=windows&sourceID=codex&windowName=weekly")
  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), { error: "Quota history unavailable" })
})

test("quota history passes upstream unavailable through as 200", async (t) => {
  const { get } = await harness(t, { output: { status: "unavailable", reason: "storage-unavailable" } })
  const response = await get("sourceID=codex&windowName=weekly")
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: "unavailable", reason: "storage-unavailable" })
})

test("quota history maps upstream failure to 502", async (t) => {
  const { get } = await harness(t, { status: 500, output: null })
  const response = await get("sourceID=codex&windowName=weekly")
  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), { error: "Quota history unavailable" })
})
