import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { createContext, runInContext } from "node:vm"

const readPage = () => readFile(new URL("../web/index.html", import.meta.url), "utf8")
const textOf = (node) => [node.textContent, node.value, ...node.children.map(textOf)].filter(Boolean).join(" ")

async function usageHarness() {
  const page = await readPage()
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  let fetchCalls = 0
  const nodes = new Map()
  const node = (key) => ({
    key, children: [], textContent: "", value: "", disabled: false, type: "",
    attributes: {}, handlers: {}, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value },
    getAttribute(name) { return this.attributes[name] ?? null },
    hasAttribute(name) { return name in this.attributes },
    removeAttribute(name) { delete this.attributes[name] },
    focus() {}, closest() { return null },
    append(...kids) { this.children.push(...kids) },
    replaceChildren(...kids) { this.children = kids },
    addEventListener(type, callback) { this.handlers[type] = callback },
  })
  const doc = {
    createElement: () => node("fresh-" + Math.random()),
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, node(selector))
      return nodes.get(selector)
    },
    querySelectorAll() { return [] },
    getElementById(id) { return this.querySelector(`#${id}`) },
    title: "", visibilityState: "hidden", addEventListener() {},
  }
  const context = createContext({
    document: doc,
    fetch: () => { fetchCalls++; return new Promise(() => {}) },
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval() { return 0 }, clearInterval() {},
    location: { hash: "" },
    window: { location: { hash: "" }, addEventListener() {} },
  })
  runInContext(script, context)
  return {
    page, context, nodes,
    render: (report) => runInContext(`renderDashboard(${JSON.stringify({ projectID: "fixture", generatedAt: Date.now(), cooldowns: [], report })})`, context),
    text: (selector) => textOf(nodes.get(selector)),
    eval: (expression) => runInContext(expression, context),
    fetchCalls: () => fetchCalls,
  }
}

const row = (over = {}) => ({
  dimension: "model", value: "prov/model", records: 4, observedTokens: 100,
  input: 40, output: 40, cacheRead: 10, cacheWrite: 5, reasoning: 5, unknownCacheRecords: 0,
  hostCostUSD: 1.23, ...over,
})

// Backend-exact ApiComponentCost: all components and counters present and valid.
const componentCost = (over = {}) => ({
  currency: "USD", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0,
  pricedRecords: 3, unpricedRecords: 1, cacheUnpricedRecords: 1, partialRecords: 1,
  ...over,
})
// Backend-exact ApiEquivalentCosts with the recorded-price clock fields (aggregate = known parts).
const equivalentCosts = (over = {}) => ({
  currencies: [{ currency: "USD", estimatedAmount: 9.99, source: "catalog" }],
  pricedRecords: 20, unpricedRecords: 10, cacheUnpricedRecords: 3, partialRecords: 1,
  unknownTokenRecords: 0, complete: false,
  pricing: "recorded-api-price", scope: "selected-range-with-older-cumulative",
  retainedUSD: 3.54, archivedUSD: 6.45, archivedRecords: 20, legacyUnknownRecords: 2,
  ...over,
})

const report = (items, over = {}) => ({
  apiVersion: 1, status: "ok", generatedAt: Date.now(),
  totals: { records: 4, observedTokens: 100, partialTokenRecords: 0, unknownTokenRecords: 0 },
  costs: { currencies: [{ currency: "USD", estimatedAmount: 5, source: "catalog" }], pricedRecords: 4, unpricedRecords: 1 },
  dimensions: { items },
  ...over,
})

test("one valid recorded-price apiEquivalentOf round-trip across both scopes", async () => {
  const h = await usageHarness()
  const all = JSON.parse(h.eval(`JSON.stringify(apiEquivalentOf(${JSON.stringify(report([row()], { apiEquivalent: equivalentCosts() }))})??null)`))
  assert.deepEqual(all, {
    currency: "USD", amount: 9.99, priced: 20, unpriced: 10, cacheUnpriced: 3, partial: 1,
    retained: 3.54, archived: 6.45, archivedRecords: 20, legacyUnknown: 2, unknownTokens: 0,
    scope: "selected-range-with-older-cumulative",
  })
  const dated = JSON.parse(h.eval(`JSON.stringify(apiEquivalentOf(${JSON.stringify(report([row()], { apiEquivalent: equivalentCosts({ scope: "retained-raw-records", archivedUSD: null, archivedRecords: 0, currencies: [{ currency: "USD", estimatedAmount: 3.54 }], pricedRecords: 12, unpricedRecords: 3 }) }))})??null)`))
  assert.equal(dated.amount, 3.54, "dated aggregate is the retained subtotal only")
  assert.equal(dated.archived, null, "dated range carries no cumulative part")
  assert.equal(dated.scope, "retained-raw-records")
  const zeroPriced = JSON.parse(h.eval(`JSON.stringify(apiEquivalentOf(${JSON.stringify(report([row()], { apiEquivalent: equivalentCosts({ currencies: [], pricedRecords: 0, unpricedRecords: 4, cacheUnpricedRecords: 0, partialRecords: 0, retainedUSD: null, archivedUSD: null, archivedRecords: 0, legacyUnknownRecords: 0 }) }))})??null)`))
  assert.equal(zeroPriced.amount, null, "legit no-priced-work payload: all unknown, amount unavailable, not 0")
  assert.equal(zeroPriced.retained, null)
})

test("apiEquivalentOf rejection matrix incl. old current-price payloads, clock fields and subsets", async () => {
  const h = await usageHarness()
  const bad = [
    ["old current-api-price payload unavailable", equivalentCosts({ pricing: "current-api-price" })],
    ["wrong scope", equivalentCosts({ scope: "archived-rollups" })],
    ["missing scope", (({ scope, ...rest }) => rest)(equivalentCosts())],
    ["complete true", equivalentCosts({ complete: true })],
    ["missing pricing literal", (({ pricing, ...rest }) => rest)(equivalentCosts())],
    ["negative retainedUSD", equivalentCosts({ retainedUSD: -2 })],
    ["string retainedUSD", equivalentCosts({ retainedUSD: "nine" })],
    ["string archivedUSD", equivalentCosts({ archivedUSD: "six" })],
    ["negative archivedUSD", equivalentCosts({ archivedUSD: -3 })],
    ["older-cumulative inside a dated range", equivalentCosts({ scope: "retained-raw-records", archivedUSD: 2 })],
    ["negative amount", equivalentCosts({ currencies: [{ currency: "USD", estimatedAmount: -1 }] })],
    ["string amount", equivalentCosts({ currencies: [{ currency: "USD", estimatedAmount: "nine" }] })],
    ["duplicate currencies", equivalentCosts({ currencies: [{ currency: "USD", estimatedAmount: 1 }, { currency: "USD", estimatedAmount: 2 }] })],
    ["malformed entry not filtered", equivalentCosts({ currencies: [{ currency: "EUR", estimatedAmount: 9.99 }] })],
    ["empty array with priced work", equivalentCosts({ currencies: [] })],
    ["entry present with no priced work", equivalentCosts({ currencies: [{ currency: "USD", estimatedAmount: 1 }], pricedRecords: 0, unpricedRecords: 4, cacheUnpricedRecords: 0, partialRecords: 0 })],
    ["fractional counter", equivalentCosts({ pricedRecords: 8.5 })],
    ["unsafe counter", equivalentCosts({ unpricedRecords: Number.MAX_SAFE_INTEGER + 1 })],
    ["missing counter", equivalentCosts({ partialRecords: undefined })],
    ["negative counter", equivalentCosts({ cacheUnpricedRecords: -1 })],
    ["partial over counted", equivalentCosts({ partialRecords: 99 })],
    ["cacheUnpriced over counted", equivalentCosts({ cacheUnpricedRecords: 99 })],
    ["fractional archivedRecords", equivalentCosts({ archivedRecords: 2.5 })],
    ["negative archivedRecords", equivalentCosts({ archivedRecords: -1 })],
    ["archivedRecords over counted", equivalentCosts({ archivedRecords: 99 })],
    ["dated scope with archivedRecords nonzero", equivalentCosts({ scope: "retained-raw-records", archivedUSD: null, archivedRecords: 4 })],
    ["both clocks null with priced work", equivalentCosts({ retainedUSD: null, archivedUSD: null })],
    ["aggregate mismatch with retained+archived", equivalentCosts({ currencies: [{ currency: "USD", estimatedAmount: 12 }] })],
    ["zero priced work with a known subtotal", equivalentCosts({ currencies: [], pricedRecords: 0, unpricedRecords: 4, cacheUnpricedRecords: 0, partialRecords: 0, retainedUSD: 2, archivedUSD: null, archivedRecords: 0, legacyUnknownRecords: 0 })],
    ["missing legacyUnknown marker needed for coverage", equivalentCosts({ legacyUnknownRecords: undefined })],
    ["legacyUnknown over unpriced", equivalentCosts({ legacyUnknownRecords: 11 })],
    ["not an object", "soon"],
  ]
  for (const [label, apiEquivalent] of bad) {
    const kept = JSON.parse(h.eval(`JSON.stringify(apiEquivalentOf(${JSON.stringify(report([row()], { apiEquivalent }))})??null)`))
    assert.equal(kept, null, `${label}: rejected whole`)
  }
})

test("apiCostOf: valid round-trip with explicit zero, and the malformed matrix rejects whole", async () => {
  const h = await usageHarness()
  const kept = JSON.parse(h.eval(`JSON.stringify(apiCostOf(${JSON.stringify(row({ apiCosts: componentCost({ total: 12.5 }) }))}))`))
  assert.deepEqual(kept, { currency: "USD", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 12.5, priced: 3, unpriced: 1, cacheUnpriced: 1, partial: 1 })
  const bad = [
    ["negative total", componentCost({ total: -5 })],
    ["missing input", componentCost({ input: undefined })],
    ["missing output", componentCost({ output: undefined })],
    ["missing cacheRead", componentCost({ cacheRead: undefined })],
    ["missing cacheWrite", componentCost({ cacheWrite: undefined })],
    ["missing total", componentCost({ total: undefined })],
    ["string total", componentCost({ total: "nine" })],
    ["negative component", componentCost({ cacheRead: -1 })],
    ["fractional priced", componentCost({ pricedRecords: 3.5 })],
    ["fractional partial", componentCost({ partialRecords: 1.5 })],
    ["negative unpriced", componentCost({ unpricedRecords: -1 })],
    ["missing priced counter", componentCost({ pricedRecords: undefined })],
    ["missing partial counter", componentCost({ partialRecords: undefined })],
    ["missing cacheUnpriced counter", componentCost({ cacheUnpricedRecords: undefined })],
    ["unsafe count overflow", componentCost({ pricedRecords: Number.MAX_SAFE_INTEGER + 1 })],
    ["cacheUnpriced over counted", componentCost({ cacheUnpricedRecords: 5 })],
    ["partial over counted", componentCost({ partialRecords: 5 })],
    ["wrong currency", componentCost({ currency: "EUR" })],
    ["missing currency", componentCost({ currency: undefined })],
    ["not an object", "soon"],
  ]
  for (const [label, apiCosts] of bad) {
    const rejected = JSON.parse(h.eval(`JSON.stringify(apiCostOf(${JSON.stringify(row({ value: "prov/x", apiCosts }))})??null)`))
    assert.equal(rejected, null, `${label}: rejected whole`)
  }
})

test("measures pane: All sums retained + older-cumulative, legacy unknowns labeled, not $0", async () => {
  const h = await usageHarness()
  h.render(report([row()], { apiEquivalent: equivalentCosts() }))
  const text = h.text("#models-cost")
  assert.match(text, /API-equivalent total/)
  assert.match(text, /≈ 9\.99 USD/)
  assert.match(text, /API equivalent · newest 90 days/)
  assert.match(text, /≈ 3\.54 USD/)
  assert.match(text, /Older than 90 days — cumulative/)
  assert.match(text, /≈ 6\.45 USD · 20 records aggregated/)
  assert.match(text, /recorded API prices across the whole selected range, including older-than-90-day totals · 20 of 30 steps priced/)
  assert.match(text, /2 with historical price not recorded/, "legacy rows tell the story, never a $0")
  const apiSlice = text.slice(text.indexOf("API-equivalent total"))
  assert.doesNotMatch(apiSlice, /≈ 0\.00 USD/)
})

test("dated range: cumulative row suppressed, retained shown; old current-price payload reads unavailable", async () => {
  const h = await usageHarness()
  h.render(report([row()], { apiEquivalent: equivalentCosts({ scope: "retained-raw-records", archivedUSD: null, archivedRecords: 0, currencies: [{ currency: "USD", estimatedAmount: 3.54 }], pricedRecords: 12, unpricedRecords: 3 }) }))
  const text = h.text("#models-cost")
  assert.match(text, /≈ 3\.54 USD/, "dated total is the retained subtotal only")
  assert.match(text, /recorded API prices over the range's retained steps · 12 of 15 steps priced/)
  assert.match(text, /API equivalent · newest 90 days/)
  assert.doesNotMatch(text, /records aggregated/, "no older cumulative value leaks into a dated range")
  const slice = text.slice(text.indexOf("Older than 90 days — cumulative"), text.indexOf("API-equivalent coverage"))
  assert.match(slice, /—/)
  const old = await usageHarness()
  old.render(report([row()], { apiEquivalent: equivalentCosts({ pricing: "current-api-price" }) }))
  const oldText = old.text("#models-cost")
  assert.doesNotMatch(oldText, /≈ \d/)
  assert.match(oldText.slice(oldText.indexOf("API-equivalent total"), oldText.indexOf("API-equivalent coverage")), /—/, "old current-price payload unavailable, unlabeled")
})

test("apiCosts render: recorded-price wording, host cost untouched, malformed rows drop to —", async () => {
  const h = await usageHarness()
  h.render(report([
    row({ value: "prov/eur", costs: { currency: "USD", total: 5, pricedRecords: 2, unpricedRecords: 1 }, apiCosts: componentCost({ currency: "EUR" }) }),
    row({ value: "prov/good", costs: { currency: "USD", total: 5, pricedRecords: 2, unpricedRecords: 1 }, apiCosts: componentCost({ total: 12.5 }) }),
  ]))
  runInContext('["prov/eur","prov/good"].forEach(key=>expandedModels.add(key));paintOverview()', h.context)
  const text = h.text("#models-table")
  assert.match(text, /12\.50 USD/)
  assert.match(text, /1\.23 USD/, "host-reported cost column untouched")
  assert.match(text, /5\.00 USD/, "ordinary estimate untouched")
  assert.match(text, /3 of 4 steps priced at recorded API prices/)
  assert.match(text, /prices recorded with the steps, not a bill/)
  assert.doesNotMatch(text, /9\.00 USD/)
})

test("static wiring and quota spacing preserved", async () => {
  const page = await readPage()
  assert.match(page, /\['Steps','num'],\['Tokens','num'],\['Share','num'],\['Cache hit','num'],\['Host cost','num'],\['API equiv\.','num']/)
  assert.match(page, /mount\('#models-table',h\('div',\{class:'ledger-wrap'\}/)
  assert.match(page, /API equivalent prices each recorded step at the API price recorded for it/)
  assert.match(page, /no historical backfill/)
  const style = page.slice(page.indexOf("<style>"), page.indexOf("</style>"))
  assert.match(style, /#quota-providers,#quota-estimates\{margin-top:24px\}/)
  assert.match(style, /#quota-panel-estimates \.note\{margin-top:26px\}/)
})

test("usage tab rendering makes no network calls", async () => {
  const h = await usageHarness()
  h.render(report([row({ apiCosts: componentCost({ total: 3 }) })], { apiEquivalent: equivalentCosts() }))
  assert.equal(h.fetchCalls(), 0)
})
