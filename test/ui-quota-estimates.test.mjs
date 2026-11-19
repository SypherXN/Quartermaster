import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { createContext, runInContext } from "node:vm"

// Runs web/index.html's inline script in a VM. The pane under test renders one card per
// (sourceID, windowName) with a current estimate and a chart of saved closed-window
// estimates; these checks assert that behaviour, not helper names.

const readPage = () => readFile(new URL("../web/index.html", import.meta.url), "utf8")
const hasClass = (node, name) => String(node?.attributes?.class ?? "").split(/\s+/).includes(name)
const descendants = node => (node ? [node, ...node.children.flatMap(descendants)] : [])
const textOf = node => node
  ? [String(node.textContent ?? ""), String(node.value ?? ""), ...node.children.map(textOf)].filter(Boolean).join(" ")
  : ""

const T0 = Date.UTC(2026, 0, 5, 0, 0)
const MIN = 60000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const ATTR = /^\[\s*([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]$/
function matchesToken(node, token) {
  if (!node || typeof node !== "object" || !node.attributes) return false
  if (token === "*") return true
  if (token.startsWith("#")) return node.attributes.id === token.slice(1)
  if (token.startsWith(".")) return hasClass(node, token.slice(1))
  const attr = ATTR.exec(token)
  if (attr) {
    if (!(attr[1] in node.attributes)) return false
    const want = attr[2] ?? attr[3] ?? attr[4]
    return want === undefined || node.attributes[attr[1]] === want
  }
  return node.tag === token
}

function createDom() {
  const roots = new Map()
  let seq = 0
  const doc = {
    activeElement: null,
    title: "",
    visibilityState: "hidden",
    roots,
    createElement(tag) { return makeNode(tag) },
    addEventListener() {},
    getElementById(id) { return doc.querySelector(`#${id}`) },
    querySelector(selector) {
      const text = String(selector)
      if (text.startsWith("#") && !/\s/.test(text)) return rootFor(text.slice(1))
      return queryAll(text)[0] ?? null
    },
    querySelectorAll(selector) { return queryAll(String(selector)) },
  }
  function makeNode(tag, root = false) {
    const node = {
      tag, key: `n${++seq}`, isRoot: root, parent: null, children: [],
      textContent: "", value: "", disabled: false, checked: false, type: "",
      hidden: false, open: false, tabIndex: 0, attributes: {}, handlers: {}, style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
      setAttribute(name, value) { node.attributes[name] = String(value) },
      getAttribute(name) { return name in node.attributes ? node.attributes[name] : null },
      hasAttribute(name) { return name in node.attributes },
      removeAttribute(name) { delete node.attributes[name] },
      append(...kids) { for (const kid of kids) { kid.parent = node; node.children.push(kid) } },
      replaceChildren(...kids) { for (const kid of node.children) kid.parent = null; node.children = []; node.append(...kids) },
      addEventListener(type, callback) { node.handlers[type] = callback },
      focus() { doc.activeElement = node },
      contains(other) { for (let item = other; item; item = item.parent) if (item === node) return true; return false },
      closest(selector) { for (let item = node; item; item = item.parent) if (matchesToken(item, selector)) return item; return null },
      querySelector(selector) { return queryWithin(node, selector, false) },
      querySelectorAll(selector) { return queryWithin(node, selector, true) },
      get firstChild() { return node.children[0] ?? null },
      get childNodes() { return node.children },
      get isConnected() { let item = node; while (item.parent) item = item.parent; return item.isRoot === true },
    }
    return node
  }
  function rootFor(id) {
    const key = `#${id}`
    if (!roots.has(key)) {
      const node = makeNode("div", true)
      node.key = key
      node.attributes.id = id
      roots.set(key, node)
    }
    return roots.get(key)
  }
  function queryWithin(scope, selector, all) {
    const tokens = String(selector).trim().split(/\s+/)
    const pool = descendants(scope).slice(1)
    const found = tokens.length === 1 ? pool.filter(node => matchesToken(node, tokens[0])) : []
    return all ? found : found[0] ?? null
  }
  function queryAll(selector) {
    const tokens = String(selector).trim().split(/\s+/)
    if (tokens.length > 2) return []
    const pool = [...roots.values()].flatMap(descendants)
    if (tokens.length === 1) return pool.filter(node => matchesToken(node, tokens[0]))
    const anchors = pool.filter(node => matchesToken(node, tokens[0]))
    return anchors.flatMap(anchor => descendants(anchor).slice(1).filter(node => matchesToken(node, tokens[1])))
  }
  return doc
}

const settle = async (rounds = 6) => { for (let index = 0; index < rounds; index++) await new Promise(resolve => setImmediate(resolve)) }

// A gateway page whose resolution each test controls, so in-flight, busy and failure
// states can be inspected synchronously between click and response.
function controlled() {
  const pages = []
  return {
    pages,
    handler: url => new Promise((resolve, reject) => { pages.push({ url, resolve, reject }) }),
  }
}

const okPage = (windows, nextCursor = null, extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({ status: "ok", windows, nextCursor, dropped: 0, metadata: {}, ...extra }),
})
const httpFailure = status => ({ ok: false, status, json: async () => ({ error: "Quota history unavailable" }) })

async function renderHarness({ historyFetch, estimates = false } = {}) {
  const page = await readPage()
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script, "the page keeps exactly one inline script")

  const clock = { now: T0 + 2 * HOUR }
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])) }
    static now() { return clock.now }
  }
  const dom = createDom()
  // The static page ships with Usage selected and the Estimates panel hidden.
  dom.querySelector("#quota-panel-estimates").hidden = !estimates
  dom.querySelector("#quota-panel-usage").hidden = estimates

  const requests = []
  const context = createContext({
    document: dom,
    Date: FakeDate,
    fetch(url, options = {}) {
      const target = String(url)
      requests.push({ url: target, options })
      if (!target.includes("kind=windows")) return new Promise(() => {})
      return historyFetch ? historyFetch(target, options) : new Promise(() => {})
    },
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval() { return 0 },
    clearInterval() {},
    location: { hash: "" },
    window: { location: { hash: "" }, addEventListener() {} },
  })
  runInContext(script, context)

  const renderSources = (sources, extra = {}) => runInContext(
    `renderDashboard(${JSON.stringify({
      projectID: "fixture", generatedAt: clock.now, cooldowns: [],
      availability: { status: "authenticated", updatedAt: clock.now, ...extra, sources },
    })})`,
    context,
  )
  return {
    context, doc: dom, nodes: dom.roots, clock,
    text: selector => textOf(dom.querySelector(selector)),
    eval: expression => runInContext(expression, context),
    render: data => runInContext(`renderDashboard(${JSON.stringify(data)})`, context),
    renderSources,
    selectView: name => runInContext(`selectQuotaView(${JSON.stringify(name)})`, context),
    requests,
    windowsRequests: () => requests.filter(request => request.url.includes("kind=windows")),
  }
}

const sourceFixture = (clock, over = {}) => ({
  status: "authenticated", sourceID: "src-a", observedAt: clock.now, windows: [], ...over,
})
const quotaWindow = (clock, label = "Daily", over = {}) => ({
  label, percent: 42, resetsAt: clock.now + DAY, ...over,
})
// A fully valid apiValue. `estimated` needs a coherent tracking span, priced records and
// a nonzero quota delta; `unavailable` needs a truthful reason and no projection.
const valueAt = (observedAt, over = {}) => {
  const spanMs = over.spanMs ?? 47 * MIN
  return {
    currency: "USD", basis: "api-equivalent-not-billed", complete: false,
    projectionStatus: "estimated", observedUSD: 5, projectedFullUSD: 40,
    reason: null, spanMs, observedAt, trackingSince: observedAt - spanMs,
    quotaDeltaPercent: 12, records: 10, pricedRecords: 10, unpricedRecords: 0, partialRecords: 0,
    ...over,
  }
}
const currentValue = (clock, over = {}) => valueAt(clock.now, { projectedFullUSD: 45.6, ...over })

const closedRow = (index, over = {}) => {
  const lastObservedAt = T0 + index * 4 * HOUR
  return {
    version: 1, sourceID: "src-a", windowName: "Daily",
    lastObservedAt, nextObservedAt: lastObservedAt + HOUR,
    lastPercent: 100, nextPercent: 0, resetsAt: lastObservedAt + 30 * MIN,
    nextResetsAt: null, resetEstimated: false, deadlineCrossed: true, ...over,
  }
}
const finalAt = (row, over = {}) => valueAt(row.lastObservedAt - MIN, over)

const cards = harness => descendants(harness.nodes.get("#quota-estimates")).filter(node => hasClass(node, "window-card"))
const cardFor = (harness, sourceID, windowName) => cards(harness)
  .find(node => node.attributes["data-source"] === sourceID && node.attributes["data-window"] === windowName)
const regions = harness => descendants(harness.nodes.get("#quota-estimates")).filter(node => hasClass(node, "wh-region"))
const regionFor = (harness, sourceID, windowName) => regions(harness)
  .find(node => node.attributes["data-source"] === sourceID && node.attributes["data-window"] === windowName)
const roleNodes = (root, role) => descendants(root).filter(node => node.attributes?.["data-role"] === role)
const providerLineOf = root => descendants(root).find(node => node.tag === "p" && /^Providers?: /.test(String(node.textContent)))
const marksOf = region => descendants(region).filter(node => hasClass(node, "wh-mark"))
const svgOf = region => descendants(region).find(node => hasClass(node, "wh-svg"))
const plotOf = region => descendants(region).find(node => hasClass(node, "wh-plot"))
const readoutOf = region => descendants(region).find(node => hasClass(node, "wh-readout"))
const moreButton = region => descendants(region).find(node => node.attributes?.["data-wh-focus"] === "more")
const detailsOf = region => descendants(region).find(node => node.tag === "details")
const tableOf = region => descendants(region).find(node => hasClass(node, "ledger"))
const marksState = region => marksOf(region).map(mark => mark.attributes["data-estimate"])

test("an empty Estimates pane asks for nothing and skips windows without a numeric percent", async () => {
  const h = await renderHarness({ estimates: true })
  h.renderSources({
    "fixture/prov": sourceFixture(h.clock, {
      windows: [
        { label: "Requests", remaining: 5, resetsAt: h.clock.now + HOUR },
        { label: "Daily", percent: null },
      ],
    }),
  })
  await settle()
  assert.match(h.text("#quota-estimates"), /No quota estimates yet/)
  assert.equal(cards(h).length, 0, "a non-numeric window gets no card")
  assert.equal(h.windowsRequests().length, 0, "and triggers no history request")
  // The Usage pane is unaffected by the Estimates redesign.
  const usage = h.text("#quota-providers")
  assert.match(usage, /Requests/)
  assert.match(usage, /Provider reset · /)
  assert.match(usage, /Usage unknown/)
})

test("one card per source and window: aliases share, independent sources stay separate", async () => {
  const h = await renderHarness({ estimates: true })
  const windows = [quotaWindow(h.clock, "Daily", { apiValue: currentValue(h.clock) })]
  h.renderSources({
    "one/provider": sourceFixture(h.clock, { sourceID: "src-a", windows }),
    "another/provider": sourceFixture(h.clock, { sourceID: "src-a", windows }),
    "other/provider": sourceFixture(h.clock, { sourceID: "src-b", windows }),
  })
  await settle()
  assert.equal(cards(h).length, 2, "two providers on one source make one card, a second source makes another")
  assert.ok(cardFor(h, "src-a", "Daily"))
  assert.ok(cardFor(h, "src-b", "Daily"))
  // The page writes "Provider:" for one alias and "Providers:" for several; match the whole
  // line so neither singular grammar nor the "another/"-contains-"other/" pair can mislead.
  assert.equal(textOf(providerLineOf(cardFor(h, "src-a", "Daily"))), "Providers: one/provider, another/provider")
  assert.equal(textOf(providerLineOf(cardFor(h, "src-b", "Daily"))), "Provider: other/provider")
  assert.equal(regions(h).length, 2, "one history region per card")
  for (const region of regions(h)) {
    assert.equal(region.attributes["data-window"], "Daily")
    assert.ok(["src-a", "src-b"].includes(region.attributes["data-source"]))
  }
  assert.equal(h.windowsRequests().length, 2, "aliases share one fetch; the other source gets its own")
  const urls = h.windowsRequests().map(request => new URL(request.url, "http://local"))
  for (const url of urls) {
    assert.equal(url.pathname, "/api/quota-history")
    assert.equal(url.searchParams.get("kind"), "windows")
    assert.equal(url.searchParams.get("limit"), "20")
    assert.equal(url.searchParams.get("windowName"), "Daily")
    assert.equal(url.searchParams.has("from"), false, "closed windows are not raw-history filtered")
    assert.equal(url.searchParams.has("cursor"), false, "the first page needs no cursor")
  }
  assert.deepEqual(urls.map(url => url.searchParams.get("sourceID")).sort(), ["src-a", "src-b"], "queries use the real source, not the provider alias")
  for (const request of h.requests) {
    assert.match(request.url, /^\/api\/quota-history\?/)
    assert.equal(request.options.credentials, "same-origin")
    assert.equal(request.options.headers, undefined, "no credentials or tokens travel in the request")
  }
})

test("the current estimate is exactly one amount with its qualifiers", async () => {
  const h = await renderHarness({ estimates: true })
  h.renderSources({ "fixture/prov": sourceFixture(h.clock, { windows: [quotaWindow(h.clock, "Daily", { apiValue: currentValue(h.clock) })] }) })
  const card = cardFor(h, "src-a", "Daily")
  const amounts = roleNodes(card, "current-amount")
  assert.equal(amounts.length, 1, "one current amount per card")
  assert.match(textOf(amounts[0]), /USD 45[.,]6/)
  assert.equal(amounts[0].parent.attributes["data-current-state"], "estimate")
  assert.equal(roleNodes(card, "current-reason").length, 0, "an available estimate needs no reason")
  assert.match(textOf(card), /10 of 10 records priced/)
  assert.match(textOf(card), /47 min tracked/)
  assert.match(textOf(card), /Fresh quota/)
})

test("zero, sub-cent and unknown current values render honestly", async () => {
  const h = await renderHarness({ estimates: true })
  const at = h.clock.now
  const zero = valueAt(at, { projectedFullUSD: 0 })
  const tiny = valueAt(at, { projectedFullUSD: 0.003 })
  h.renderSources({
    "fixture/prov": sourceFixture(h.clock, { sourceID: "src-a", windows: [quotaWindow(h.clock, "Daily", { apiValue: zero })] }),
    "fixture/other": sourceFixture(h.clock, { sourceID: "src-b", windows: [quotaWindow(h.clock, "Weekly", { apiValue: tiny })] }),
  })
  const zeroCard = cardFor(h, "src-a", "Daily")
  assert.match(textOf(roleNodes(zeroCard, "current-amount")[0]), /USD 0\b/)
  assert.equal(roleNodes(zeroCard, "current-reason").length, 0, "an explicit zero is a real estimate")
  const tinyCard = cardFor(h, "src-b", "Weekly")
  assert.match(textOf(roleNodes(tinyCard, "current-amount")[0]), /USD <0[.,]01/, "a positive sub-cent amount never becomes a literal zero")
  assert.doesNotMatch(textOf(tinyCard), /USD 0\b/)
  const unknown = await renderHarness({ estimates: true })
  unknown.renderSources({ "fixture/prov": sourceFixture(unknown.clock, { windows: [quotaWindow(unknown.clock)] }) })
  const unknownCard = cardFor(unknown, "src-a", "Daily")
  assert.equal(unknownCard.attributes["data-source"], "src-a")
  assert.equal(roleNodes(unknownCard, "current-amount").length, 1, "not tracked still renders exactly one amount slot")
  assert.match(textOf(roleNodes(unknownCard, "current-amount")[0]), /No estimate/)
  assert.match(textOf(roleNodes(unknownCard, "current-reason")[0]), /Not tracked yet/)
})

test("stale, unauthenticated and clock-mismatched sources hide the current dollars but keep saved history", async () => {
  const ctl = controlled()
  const h = await renderHarness({ estimates: true, historyFetch: ctl.handler })
  const saved = { ...closedRow(0), finalEstimate: finalAt(closedRow(0), { projectedFullUSD: 76.54 }) }
  h.renderSources({ "fixture/prov": sourceFixture(h.clock, { stale: true, windows: [quotaWindow(h.clock, "Daily", { apiValue: currentValue(h.clock) })] }) })
  await settle()
  ctl.pages[0].resolve(okPage([saved]))
  await settle()
  const card = cardFor(h, "src-a", "Daily")
  assert.equal(roleNodes(card, "current-amount").length, 1)
  assert.match(textOf(roleNodes(card, "current-reason")[0]), /Stale quota reading/)
  assert.doesNotMatch(textOf(card), /USD 45[.,]6/, "a stale quota never presents a current dollar value")
  assert.match(svgOf(regionFor(h, "src-a", "Daily")).attributes["aria-label"], /USD 76[.,]54/, "frozen history is unaffected by current staleness")

  const unauthenticated = await renderHarness({ estimates: true })
  unauthenticated.renderSources({ "fixture/prov": sourceFixture(unauthenticated.clock, { authenticated: false, windows: [quotaWindow(unauthenticated.clock, "Daily", { apiValue: currentValue(unauthenticated.clock) })] }) })
  assert.match(textOf(roleNodes(cardFor(unauthenticated, "src-a", "Daily"), "current-reason")[0]), /Stale quota reading/)

  const mismatched = await renderHarness({ estimates: true })
  mismatched.renderSources({ "fixture/prov": sourceFixture(mismatched.clock, { windows: [quotaWindow(mismatched.clock, "Daily", { apiValue: valueAt(mismatched.clock.now - MIN, { projectedFullUSD: 45.6 }) })] }) })
  const cardMismatch = cardFor(mismatched, "src-a", "Daily")
  assert.match(textOf(roleNodes(cardMismatch, "current-reason")[0]), /does not match the latest quota reading/)
  assert.doesNotMatch(textOf(cardMismatch), /USD 45[.,]6/)
})

test("the chart plots only saved final estimates, never raw points, observed subtotals or maxed snapshots", async () => {
  const ctl = controlled()
  const h = await renderHarness({ estimates: true, historyFetch: ctl.handler })
  h.renderSources({ "fixture/prov": sourceFixture(h.clock, { windows: [quotaWindow(h.clock)] }) })
  await settle()

  const first = closedRow(0)
  const savedRow = {
    ...first,
    finalEstimate: finalAt(first, { projectedFullUSD: 76.54 }),
    // The gateway carries these for other consumers; the chart must ignore them.
    apiValue: valueAt(first.lastObservedAt - MIN, { observedUSD: 98.76, projectedFullUSD: 87.65 }),
    maxed: { capturedAt: first.lastObservedAt, value: valueAt(first.lastObservedAt - MIN, { projectedFullUSD: 99.99 }) },
    boundaryPoint: { secret: "PRIVATE_BOUNDARY" },
  }
  const second = closedRow(1)
  const unavailableRow = {
    ...second,
    apiValue: valueAt(second.lastObservedAt - MIN, { projectedFullUSD: 12.34 }),
    finalEstimate: finalAt(second, { projectionStatus: "unavailable", projectedFullUSD: null, reason: "Too little history" }),
  }
  const third = closedRow(2)
  // A final estimate observed after the boundary is not a valid saved value.
  const futureFinal = { ...third, apiValue: valueAt(third.lastObservedAt - MIN, { projectedFullUSD: 12.34 }), finalEstimate: valueAt(third.lastObservedAt + 2 * MIN, { projectedFullUSD: 55 }) }
  const fourth = closedRow(3)
  const apiValueOnly = { ...fourth, apiValue: valueAt(fourth.lastObservedAt - MIN, { projectedFullUSD: 12.34 }) }
  const rawPoint = { observedAt: T0, percent: 5, apiValue: valueAt(T0, { projectedFullUSD: 999 }) }

  ctl.pages[0].resolve(okPage([savedRow, unavailableRow, futureFinal, apiValueOnly], null, { points: [rawPoint] }))
  await settle()
  const region = regionFor(h, "src-a", "Daily")
  const svg = svgOf(region)
  assert.ok(svg, "a saved estimate gives the card a chart")
  const label = svg.attributes["aria-label"]
  assert.match(label, /^Saved estimates for Daily on src-a: 1 of 4 loaded closed windows have an estimate/)
  assert.match(label, /USD 76[.,]54/)
  assert.match(label, /Y axis: USD per full window/)
  assert.match(label, /X axis: closed windows, oldest first/)
  assert.equal(svg.attributes.role, "img")
  assert.deepEqual(marksState(region), ["saved", "none", "none", "none"], "only the final estimate becomes a saved mark")
  const marks = marksOf(region)
  assert.match(textOf(marks[0]), /≈ USD 76[.,]54/)
  assert.match(textOf(marks[1]), /no estimate saved/)
  assert.match(textOf(marks[2]), /no estimate saved/, "a final estimate after the boundary is not fallback-usable")
  assert.match(textOf(marks[3]), /no estimate saved/, "apiValue alone is never a chart value")
  const regionText = textOf(region)
  assert.equal((regionText.match(/≈ USD/g) || []).length, 1, "exactly one saved amount")
  assert.match(regionText, /Closed windows, oldest first \(4\)/)
  assert.doesNotMatch(regionText, /87[.,]65|99[.,]99|98[.,]76|12[.,]34|USD 55|999|PRIVATE_BOUNDARY/, "no observed subtotal, maxed snapshot, raw point or private field reaches the pane")
  const rows = descendants(tableOf(region)).filter(node => node.tag === "tr").filter(node => node.parent?.tag === "tbody")
  assert.equal(rows.length, 4)
  assert.match(textOf(rows[1].children[3]), /Too little history/, "an unavailable window keeps its truthful reason in details")
})

test("all-unavailable, empty and unavailable-channel states stay honest", async () => {
  const all = await renderHarness({ estimates: true, historyFetch: async () => okPage([
    { ...closedRow(0), finalEstimate: valueAt(T0, { projectionStatus: "unavailable", projectedFullUSD: null, reason: "No prices" }) },
    { ...closedRow(1), finalEstimate: valueAt(T0, { projectionStatus: "unavailable", projectedFullUSD: null, reason: "Too little history" }) },
  ]) })
  all.renderSources({ "fixture/prov": sourceFixture(all.clock, { windows: [quotaWindow(all.clock)] }) })
  await settle()
  const allRegion = regionFor(all, "src-a", "Daily")
  assert.equal(svgOf(allRegion), undefined, "no chart is invented without a saved amount")
  assert.match(textOf(allRegion), /None of the loaded closed windows has a saved estimate/)
  assert.match(textOf(allRegion), /No prices/)
  assert.match(textOf(allRegion), /Too little history/)
  assert.equal(marksOf(allRegion).length, 0)
  assert.equal(descendants(tableOf(allRegion)).filter(node => node.tag === "tr" && node.parent?.tag === "tbody").length, 2, "unavailable windows are still listed")

  const empty = await renderHarness({ estimates: true, historyFetch: async () => okPage([], null) })
  empty.renderSources({ "fixture/prov": sourceFixture(empty.clock, { windows: [quotaWindow(empty.clock)] }) })
  await settle()
  assert.match(textOf(regionFor(empty, "src-a", "Daily")), /No closed window saved yet\. An estimate is saved here when a Daily window closes\./)

  const unavailable = await renderHarness({ estimates: true, historyFetch: async () => ({ ok: true, status: 200, json: async () => ({ status: "unavailable" }) }) })
  unavailable.renderSources({ "fixture/prov": sourceFixture(unavailable.clock, { windows: [quotaWindow(unavailable.clock)] }) })
  await settle()
  assert.match(textOf(regionFor(unavailable, "src-a", "Daily")), /Saved window estimates are unavailable for this source/)

  const nameless = await renderHarness({ estimates: true })
  nameless.renderSources({ "fixture/prov": sourceFixture(nameless.clock, { sourceID: undefined, windows: [quotaWindow(nameless.clock)] }) })
  await settle()
  assert.match(textOf(regionFor(nameless, "", "Daily")), /Saved estimates are unavailable: this source or window has no stable name/)
  assert.equal(nameless.windowsRequests().length, 0, "an unstable identity is never queried")
})

test("malformed closed rows are counted, not shown, and legacy rows stay readable", async () => {
  const base0 = closedRow(0)
  const base1 = closedRow(1)
  const base2 = closedRow(2)
  const legacy = { ...base0, finalEstimate: finalAt(base0, { projectedFullUSD: 21 }) }
  const anchored = { ...base1, instanceAnchorAt: base1.lastObservedAt - 2 * HOUR, finalEstimate: finalAt(base1, { projectionStatus: "unavailable", projectedFullUSD: null, reason: "No pricing" }) }
  const badMoney = { ...base2, finalEstimate: { ...finalAt(base2), projectedFullUSD: -1 } }
  const bad = closedRow(5)
  const h = await renderHarness({ estimates: true, historyFetch: async () => okPage([
    legacy, anchored, badMoney, null,
    { ...bad, sourceID: "src-other" },
    { ...bad, windowName: "Weekly" },
    { ...bad, nextObservedAt: bad.lastObservedAt },
    { ...bad, lastPercent: 101 },
  ]) })
  h.renderSources({ "fixture/prov": sourceFixture(h.clock, { windows: [quotaWindow(h.clock)] }) })
  await settle()
  const region = regionFor(h, "src-a", "Daily")
  assert.match(textOf(region), /Showing 3 closed windows, oldest first/)
  assert.match(textOf(region), /5 saved items could not be shown\./, "rejected rows are reported, not silently dropped")
  assert.equal(descendants(tableOf(region)).filter(node => node.tag === "tr" && node.parent?.tag === "tbody").length, 3)
  assert.match(textOf(region), /USD 21/)
  assert.match(svgOf(region).attributes["aria-label"], /1 of 3 loaded closed windows have an estimate/, "a malformed monetary value is not charted")
  assert.doesNotMatch(textOf(region), /src-other|Weekly/, "cross-identity rows never reach the card")
  // A legacy row without an anchor is accepted; an anchored row explains the tracked
  // span; a rejected monetary payload stays a row without an estimate.
  const marks = marksOf(region)
  assert.equal(marks.length, 3)
  assert.deepEqual(marksState(region), ["saved", "none", "none"])
  marks[0].handlers.click()
  assert.match(textOf(readoutOf(region)), /Saved estimate ≈ USD 21/)
  assert.doesNotMatch(textOf(readoutOf(region)), /Tracked from/)
  marks[1].handlers.click()
  assert.match(textOf(readoutOf(region)), /Tracked from/)
  assert.match(textOf(readoutOf(region)), /No pricing/)
  marks[2].handlers.click()
  assert.match(textOf(readoutOf(region)), /No estimate saved \(no estimate was recorded for this window\)/)
})

test("pagination is explicit, deduplicated and keeps pages oldest first", async () => {
  const ctl = controlled()
  const h = await renderHarness({ estimates: true, historyFetch: ctl.handler })
  h.renderSources({ "fixture/prov": sourceFixture(h.clock, { windows: [quotaWindow(h.clock)] }) })
  await settle()
  const first = { ...closedRow(0), finalEstimate: finalAt(closedRow(0), { projectedFullUSD: 21 }) }
  const second = { ...closedRow(1), finalEstimate: finalAt(closedRow(1), { projectedFullUSD: 32 }) }
  ctl.pages[0].resolve(okPage([first], "c1"))
  await settle()
  const region = regionFor(h, "src-a", "Daily")
  assert.match(textOf(region), /Showing 1 closed window, oldest first/)
  assert.match(textOf(region), /Newer windows are not loaded yet\./)
  const loadMore = moreButton(region)
  assert.ok(loadMore, "a non-null cursor offers an explicit control")
  assert.equal(textOf(loadMore), "Load newer windows")
  assert.equal(loadMore.attributes["aria-disabled"], "false")

  loadMore.handlers.click()
  loadMore.handlers.click()
  assert.equal(ctl.pages.length, 2, "a second click while in flight starts no second request")
  assert.equal(new URL(ctl.pages[1].url, "http://local").searchParams.get("cursor"), "c1")
  ctl.pages[1].resolve(okPage([first, second], null))
  await settle()

  assert.equal(moreButton(region), undefined, "an exhausted cursor removes the control")
  assert.doesNotMatch(textOf(region), /Newer windows are not loaded yet/)
  const rows = descendants(tableOf(region)).filter(node => node.tag === "tr" && node.parent?.tag === "tbody")
  assert.equal(rows.length, 2, "the repeated row is merged by durable identity")
  assert.match(textOf(rows[0].children[2]), /USD 21/, "merged pages stay oldest first")
  assert.match(textOf(rows[1].children[2]), /USD 32/)
  // Text position is not an ordering check: the y-axis label names the maximum (USD 32)
  // before any mark is drawn. Assert the mark order the reader actually navigates.
  const marks = marksOf(region)
  assert.deepEqual(marksState(region), ["saved", "saved"], "both pages keep a saved estimate")
  assert.deepEqual(marks.map(mark => mark.attributes["data-index"]), ["0", "1"], "marks are indexed oldest first")
  assert.match(textOf(marks[0]), /≈ USD 21/)
  assert.match(textOf(marks[1]), /≈ USD 32/)
  assert.match(textOf(readoutOf(region)), /Window 1 of 2 loaded/, "the earlier selection is kept, not jumped to the newest window")
  assert.match(textOf(readoutOf(region)), /Saved estimate ≈ USD 21/)
  assert.match(textOf(region), /Showing 2 closed windows/)
})

test("a page whose cursor does not advance is rejected without losing loaded rows", async () => {
  const ctl = controlled()
  const h = await renderHarness({ estimates: true, historyFetch: ctl.handler })
  h.renderSources({ "fixture/prov": sourceFixture(h.clock, { windows: [quotaWindow(h.clock)] }) })
  await settle()
  const first = { ...closedRow(0), finalEstimate: finalAt(closedRow(0), { projectedFullUSD: 21 }) }
  const second = { ...closedRow(1), finalEstimate: finalAt(closedRow(1), { projectedFullUSD: 32 }) }
  ctl.pages[0].resolve(okPage([first], "c1"))
  await settle()
  moreButton(regionFor(h, "src-a", "Daily")).handlers.click()
  ctl.pages[1].resolve(okPage([second], "c1"))
  await settle()
  const region = regionFor(h, "src-a", "Daily")
  assert.match(textOf(region), /Newer windows could not be loaded\. The windows above are still shown\./)
  assert.match(textOf(region), /USD 21/)
  assert.doesNotMatch(textOf(region), /USD 32/, "a rejected page contributes no rows")
  assert.equal(textOf(moreButton(region)), "Retry loading newer windows")
  moreButton(region).handlers.click()
  ctl.pages[2].resolve(okPage([second], null))
  await settle()
  assert.match(textOf(region), /USD 32/)
  assert.doesNotMatch(textOf(region), /could not be loaded/)

  const oversized = await renderHarness({ estimates: true, historyFetch: async () => okPage(Array.from({ length: 21 }, (_, index) => closedRow(index))) })
  oversized.renderSources({ "fixture/prov": sourceFixture(oversized.clock, { windows: [quotaWindow(oversized.clock)] }) })
  await settle()
  assert.match(textOf(regionFor(oversized, "src-a", "Daily")), /Saved window estimates could not be loaded\./, "more than one page per response is rejected")
})

test("a failed append keeps the loaded page, keeps button focus and does not retry in a loop", async () => {
  const ctl = controlled()
  const h = await renderHarness({ estimates: true, historyFetch: ctl.handler })
  h.renderSources({ "fixture/prov": sourceFixture(h.clock, { windows: [quotaWindow(h.clock)] }) })
  await settle()
  const first = { ...closedRow(0), finalEstimate: finalAt(closedRow(0), { projectedFullUSD: 21 }) }
  ctl.pages[0].resolve(okPage([first], "c1"))
  await settle()
  const region = regionFor(h, "src-a", "Daily")

  moreButton(region).focus()
  moreButton(region).handlers.click()
  const busy = moreButton(region)
  assert.equal(busy.attributes["aria-disabled"], "true", "the in-flight control is aria-disabled")
  assert.notEqual(busy.disabled, true, "aria-disabled keeps the control focusable")
  assert.match(textOf(busy), /Loading/, "the in-flight control says it is loading")
  assert.equal(h.doc.activeElement, busy, "the in-flight repaint keeps focus on the same control")

  ctl.pages[1].resolve(httpFailure(503))
  await settle()
  assert.match(textOf(region), /Newer windows could not be loaded\. The windows above are still shown\./)
  assert.match(textOf(region), /USD 21/, "a failed append preserves the first page")
  const retry = moreButton(region)
  assert.equal(textOf(retry), "Retry loading newer windows")
  assert.equal(retry.attributes["aria-disabled"], "false")
  assert.equal(h.doc.activeElement, retry, "focus returns to the rebuilt retry control")

  h.renderSources({ "fixture/prov": sourceFixture(h.clock, { windows: [quotaWindow(h.clock)] }) })
  h.renderSources({ "fixture/prov": sourceFixture(h.clock, { windows: [quotaWindow(h.clock)] }) })
  await settle()
  assert.equal(ctl.pages.length, 2, "a repaint never retries a cached failure")
  assert.match(textOf(regionFor(h, "src-a", "Daily")), /USD 21/)

  moreButton(regionFor(h, "src-a", "Daily")).handlers.click()
  ctl.pages[2].resolve(okPage([{ ...closedRow(1), finalEstimate: finalAt(closedRow(1), { projectedFullUSD: 32 }) }], null))
  await settle()
  const healed = regionFor(h, "src-a", "Daily")
  assert.match(textOf(healed), /USD 32/)
  assert.doesNotMatch(textOf(healed), /could not be loaded/)
})

test("the fetch waits for the visible tab, shares one in-flight read and honours the cache window", async () => {
  const ctl = controlled()
  const h = await renderHarness({ historyFetch: ctl.handler })
  const windows = [quotaWindow(h.clock)]
  h.renderSources({ "fixture/prov": sourceFixture(h.clock, { windows }) })
  await settle()
  assert.equal(ctl.pages.length, 0, "a hidden tab asks for nothing")
  assert.match(textOf(regionFor(h, "src-a", "Daily")), /Loading saved windows/)

  h.selectView("estimates")
  await settle()
  assert.equal(ctl.pages.length, 1, "selecting the Estimates tab paints and requests")
  h.renderSources({ "fixture/prov": sourceFixture(h.clock, { windows }) })
  h.selectView("estimates")
  await settle()
  assert.equal(ctl.pages.length, 1, "a second subscriber joins the same in-flight read")

  ctl.pages[0].resolve(okPage([{ ...closedRow(0), finalEstimate: finalAt(closedRow(0), { projectedFullUSD: 21 }) }]))
  await settle()
  assert.match(textOf(regionFor(h, "src-a", "Daily")), /≈ USD 21/)

  h.clock.now += 59 * 1000
  h.renderSources({ "fixture/prov": sourceFixture(h.clock, { windows }) })
  await settle()
  assert.equal(ctl.pages.length, 1, "a repaint inside the cache window reuses the response")

  h.clock.now += 2 * 1000
  h.renderSources({ "fixture/prov": sourceFixture(h.clock, { windows }) })
  await settle()
  assert.equal(ctl.pages.length, 2, "an expired cache window refreshes once")
  assert.equal(new URL(ctl.pages[1].url, "http://local").searchParams.has("cursor"), false, "a refresh re-reads from the start of the newest page")
})

test("details state, chart keyboard readout and accessible labels survive a repaint", async () => {
  const h = await renderHarness({ estimates: true, historyFetch: async () => okPage([
    { ...closedRow(0), instanceAnchorAt: closedRow(0).lastObservedAt - 2 * HOUR, finalEstimate: finalAt(closedRow(0), { projectedFullUSD: 21 }) },
    { ...closedRow(1), finalEstimate: finalAt(closedRow(1), { projectionStatus: "unavailable", projectedFullUSD: null, reason: "No pricing" }) },
  ]) })
  const windows = [quotaWindow(h.clock)]
  h.renderSources({ "fixture/prov": sourceFixture(h.clock, { windows }) })
  await settle()
  const region = regionFor(h, "src-a", "Daily")
  const plot = plotOf(region)
  assert.equal(plot.attributes.role, "group")
  assert.equal(plot.attributes.tabindex, "0")
  assert.equal(plot.attributes["data-wh-focus"], "plot")
  assert.match(plot.attributes["aria-label"], /Saved estimates chart for Daily\. Use the left and right arrow keys/)
  const readout = readoutOf(region)
  assert.equal(readout.attributes["aria-live"], "polite")
  assert.match(textOf(readout), /Window 2 of 2 loaded/)
  assert.match(textOf(readout), /No estimate saved: No pricing/)
  assert.match(textOf(readout), /the exact end is not known/)
  assert.match(textOf(readout), /reported reset/)

  plot.handlers.keydown({ key: "Home", preventDefault() {} })
  assert.match(textOf(readoutOf(region)), /Window 1 of 2 loaded/)
  assert.match(textOf(readoutOf(region)), /Saved estimate ≈ USD 21/)
  assert.match(textOf(readoutOf(region)), /tracked from/i)
  assert.match(textOf(readoutOf(region)), /not the provider's start time/)
  plot.handlers.keydown({ key: "ArrowRight", preventDefault() {} })
  assert.match(textOf(readoutOf(region)), /Window 2 of 2 loaded/)
  plot.handlers.keydown({ key: "End", preventDefault() {} })
  assert.match(textOf(readoutOf(region)), /Window 2 of 2 loaded/)
  plot.handlers.keydown({ key: "ArrowLeft", preventDefault() {} })
  assert.match(textOf(readoutOf(region)), /Window 1 of 2 loaded/)
  marksOf(region)[1].handlers.click()
  assert.match(textOf(readoutOf(region)), /Window 2 of 2 loaded/)

  const details = detailsOf(region)
  assert.equal(details.tag, "details")
  const summary = descendants(details).find(node => node.tag === "summary")
  assert.equal(summary.attributes["data-wh-focus"], "details")
  assert.equal(textOf(summary), "Window details (2)")
  assert.ok(tableOf(region), "the details disclosure carries the ledger table")
  assert.match(textOf(tableOf(region)), /Closed windows, oldest first\. The close falls somewhere between the two quota observations listed\./)
  details.open = true
  details.handlers.toggle()

  plotOf(region).focus()
  h.renderSources({ "fixture/prov": sourceFixture(h.clock, { windows }) })
  await settle()
  const repainted = regionFor(h, "src-a", "Daily")
  assert.equal(detailsOf(repainted).open, true, "the disclosure keeps its open state across a repaint")
  assert.equal(h.doc.activeElement, plotOf(repainted), "the keyboard user keeps their place across a repaint")
})

test("quota tabs, the Usage pane and routing annotations are unchanged", async () => {
  const page = await readPage()
  assert.equal((page.match(/id="quota-tab-/g) || []).length, 2, "exactly two quota tabs")
  assert.match(page, /id="quota-tab-usage" aria-selected="true" aria-controls="quota-panel-usage" tabindex="0"/)
  assert.match(page, /id="quota-tab-estimates" aria-selected="false" aria-controls="quota-panel-estimates" tabindex="-1"/)
  assert.match(page, /id="quota-panel-estimates" role="tabpanel" aria-labelledby="quota-tab-estimates" tabindex="-1" hidden/)

  const h = await renderHarness()
  h.selectView("usage")
  assert.equal(h.nodes.get("#quota-panel-estimates").hidden, true)
  assert.equal(h.nodes.get("#quota-panel-usage").hidden, false)
  const usageTab = h.nodes.get("#quota-tab-usage")
  const estimatesTab = h.nodes.get("#quota-tab-estimates")
  assert.ok(usageTab && estimatesTab, "both tabs are wired at init")
  estimatesTab.handlers.click()
  assert.equal(estimatesTab.attributes["aria-selected"], "true")
  assert.equal(usageTab.attributes["aria-selected"], "false")
  assert.equal(h.nodes.get("#quota-panel-estimates").hidden, false)
  assert.equal(h.nodes.get("#quota-panel-usage").hidden, true)
  assert.equal(estimatesTab.tabIndex, 0)
  assert.equal(usageTab.tabIndex, -1)
  estimatesTab.handlers.keydown({ key: "ArrowLeft", preventDefault() {} })
  assert.equal(usageTab.attributes["aria-selected"], "true")
  assert.equal(h.nodes.get("#quota-panel-usage").hidden, false)
  assert.equal(usageTab.tabIndex, 0)

  h.renderSources({ "fixture/prov": sourceFixture(h.clock, { windows: [quotaWindow(h.clock)] }) })
  const usage = h.text("#quota-providers")
  assert.match(usage, /Daily 42% used/)
  assert.match(usage, /Provider reset · /)
  assert.doesNotMatch(usage, /USD|cutoff|Estimate ·/)

  const g = await renderHarness()
  const window95 = percent => ({ label: "Daily", percent, resetsAt: g.clock.now + HOUR })
  g.render({
    projectID: "fixture", generatedAt: g.clock.now, cooldowns: [],
    availability: {
      status: "authenticated",
      sources: {
        "fixture/low": { status: "authenticated", observedAt: g.clock.now, windows: [window95(95)] },
        "fixture/full": { status: "authenticated", observedAt: g.clock.now, windows: [window95(100)] },
      },
    },
  })
  g.eval("paintRouting()")
  const screen = g.text("#routing-strategies") + " " + g.text("#routing-groups")
  assert.match(screen, /95% used/)
  assert.doesNotMatch(screen, /95% used · quota fully used/, "95% is not marked limited")
  assert.match(screen, /100% used · quota fully used/, "only 100% is fully used")
})

test("the pane notes state the retention, non-billed and non-additive limits", async () => {
  const page = await readPage()
  const panel = page.slice(page.indexOf('id="quota-panel-estimates"'), page.indexOf('id="quota-estimates"'))
  assert.match(panel, /informational only/)
  assert.match(panel, /not a bill/)
  assert.match(panel, /never add their estimates together/)
  assert.match(panel, /not limited to 90 days/)
  assert.match(panel, /shown as a gap, never as zero/)
  assert.match(panel, /API-price equivalents/)
  assert.match(panel, /no historical backfill/)
  assert.doesNotMatch(panel, /Past windows|over the last 7 window lengths/, "obsolete observation-chart wording is gone")
})
