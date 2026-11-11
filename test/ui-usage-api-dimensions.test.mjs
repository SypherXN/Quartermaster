import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { createContext, runInContext } from "node:vm"

const readPage = () => readFile(new URL("../web/index.html", import.meta.url), "utf8")
const textOf = (node) => [node.textContent, node.value, ...node.children.map(textOf)].filter(Boolean).join(" ")
const collect = (node, out = []) => { for (const c of node?.children ?? []) { out.push(c); collect(c, out) } return out }

async function dimsHarness() {
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
    render: (data) => runInContext(`renderDashboard(${JSON.stringify({ projectID: "fixture", generatedAt: Date.now(), cooldowns: [], ...data })})`, context),
    text: (selector) => textOf(nodes.get(selector)),
    eval: (expression) => runInContext(expression, context),
    fetchCalls: () => fetchCalls,
  }
}

// Backend-exact ApiComponentCost; helpers on the page whitelist and display it verbatim.
const componentCost = (over = {}) => ({
  currency: "USD", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0,
  pricedRecords: 2, unpricedRecords: 1, cacheUnpricedRecords: 0, partialRecords: 1,
  ...over,
})
const apiEquivalent = (over = {}) => ({
  currencies: [{ currency: "USD", estimatedAmount: 9.99, source: "catalog" }],
  pricedRecords: 20, unpricedRecords: 10, cacheUnpricedRecords: 3, partialRecords: 1,
  unknownTokenRecords: 4, complete: false,
  pricing: "recorded-api-price", scope: "selected-range-with-older-cumulative",
  retainedUSD: 3.54, archivedUSD: 6.45, archivedRecords: 20, legacyUnknownRecords: 2,
  ...over,
})

const dims = (over = {}) => ({
  apiVersion: 1, status: "ok", generatedAt: Date.now(),
  totals: { records: 10, observedTokens: 300, partialTokenRecords: 0, unknownTokenRecords: 4 },
  costs: { currencies: [{ currency: "USD", estimatedAmount: 20, source: "catalog" }], pricedRecords: 9, unpricedRecords: 1 },
  apiEquivalent: apiEquivalent(),
  dimensions: { items: [
    { dimension: "provider", value: "prov/a", records: 3, observedTokens: 90, cacheHitRate: 0.5, hostCostUSD: 2.5, apiCosts: componentCost({ total: 1.25 }) },
    { dimension: "provider", value: "prov/b", records: 3, observedTokens: 60, hostCostUSD: 4.5, apiCosts: componentCost({ total: 0.75 }) },
  ] },
  projects: { items: [{ projectID: "p1", projectName: "Alpha", sessions: 2, records: 3, observedTokens: 50, lastObservedAt: Date.now(), apiCosts: componentCost({ total: 3 }) }],
    apiCosts: componentCost({ total: 12, pricedRecords: 5, unpricedRecords: 1, partialRecords: 1 }) },
  agentAttribution: {
    dimensions: { items: [{ agentID: "root", sessions: 1, records: 2, observedTokens: 40, apiCosts: componentCost({ total: 0.5 }) }] },
    unattributed: { records: 1, observedTokens: 5, apiCosts: componentCost({ total: 0.25 }) },
    apiCosts: componentCost({ total: 1.3, pricedRecords: 3, unpricedRecords: 1, partialRecords: 1 }),
  },
  directUsage: {
    records: 2, observedTokens: 30, complete: false,
    apiCosts: componentCost({ total: 4, pricedRecords: 2, unpricedRecords: 0, partialRecords: 0 }),
    dimensions: { items: [
      { pluginName: "grep", pluginID: "grep@1", providerID: "prov/a", modelID: "m1", records: 1, observedTokens: 10, apiCosts: componentCost({ total: 2.5, pricedRecords: 1, unpricedRecords: 0, partialRecords: 0 }) },
      { pluginName: "grep", pluginID: "other@2", providerID: "prov/b", modelID: "m2", records: 1, observedTokens: 20, apiCosts: componentCost({ total: 7, pricedRecords: 1, unpricedRecords: 0, partialRecords: 0 }) },
    ] },
  },
  ...over,
})

test("providers tab: per-provider API column beside Host cost; whole-ledger stat distinct from row values", async () => {
  const h = await dimsHarness()
  h.render(dims())
  const text = h.text("#providers-table")
  assert.match(text, /API equiv\./)
  assert.match(text, /1\.25 USD/, "prov/a row shows its own api cost")
  assert.match(text, /0\.75 USD/, "prov/b row shows its own api cost")
  assert.match(text, /2\.50 USD/, "host cost column untouched")
  assert.doesNotMatch(text, /12\.5|whole ledger/i)
  const stats = h.text("#providers-stats")
  assert.match(stats, /API equivalent/)
  assert.match(stats, /≈ 9\.99 USD/, "stat is the backend whole-ledger total, not a row sum")
  assert.match(stats, /Whole ledger · recorded API prices incl\. unattributed · not a bill/)
})

test("agents tab: rows and unattributed row carry apiCosts; stat is agentAttribution.apiCosts, not a row sum", async () => {
  const h = await dimsHarness()
  h.render(dims())
  const text = h.text("#agents-table")
  assert.match(text, /API equiv\./)
  assert.match(text, /0\.50 USD/, "root agent row")
  assert.match(text, /0\.25 USD/, "unattributed agent row shows its own api cost, not blank")
  const stats = h.text("#agents-stats")
  assert.match(stats, /≈ 1\.30 USD/, "stat is the backend section aggregate (rows incl. unattributed sum to 0.75)")
  assert.match(stats, /All agents incl\. unattributed · recorded API prices · not a bill/)
  assert.doesNotMatch(stats, /9\.99/, "agents no longer reuse the whole-ledger apiEquivalent total")
})

test("projects tab: per-project api cost with coverage; stat is projects.apiCosts host-only, footnote has a total", async () => {
  const h = await dimsHarness()
  h.render(dims())
  runInContext('expandedProjects.add("p1");paintOverview()', h.context)
  const text = h.text("#projects-table")
  assert.match(text, /API equiv\./)
  assert.match(text, /3\.00 USD/, "per-project api cost total")
  assert.match(text, /2 of 3 steps priced at recorded API prices/, "per-project coverage")
  const stats = h.text("#projects-stats")
  assert.match(stats, /API equivalent/)
  assert.match(stats, /≈ 12\.00 USD/, "stat is projects.apiCosts, not the visible-row sum of 3.00")
  assert.match(stats, /Host usage only · 5 of 6 steps priced at recorded API prices · not a bill/)
  assert.match(text, /host-usage recorded-price subtotal/, "footnote names the total instead of denying one")
  assert.doesNotMatch(text, /sits on the Models measures table/)
})

test("plugins tab: section aggregate stat labeled self-reported and separate; rows keep own apiCosts by plugin id", async () => {
  const h = await dimsHarness()
  h.render(dims())
  const stats = h.text("#plugins-stats")
  assert.match(stats, /API equivalent/)
  assert.match(stats, /≈ 4\.00 USD/, "stat is directUsage.apiCosts, not a row merge")
  assert.match(stats, /Self-reported plugin calls · recorded API prices · not part of the host total/)
  const text = h.text("#overview-direct")
  assert.match(text, /2\.50 USD/, "grep@1 row keeps its own cost")
  assert.match(text, /7\.00 USD/, "same-named other@2 row is not merged with grep@1")
  assert.match(text, /API equiv\./)
})

test("zero priced, missing and malformed apiCosts render — without breaking ordinary tokens/costs", async () => {
  const h = await dimsHarness()
  h.render(dims({
    dimensions: { items: [
      { dimension: "provider", value: "prov/zero", records: 1, observedTokens: 10, apiCosts: componentCost({ pricedRecords: 0, unpricedRecords: 3, total: 0 }) },
      { dimension: "provider", value: "prov/none", records: 1, observedTokens: 10, hostCostUSD: 1 },
      { dimension: "provider", value: "prov/bad", records: 1, observedTokens: 10, apiCosts: { currency: "EUR", total: 9, pricedRecords: 1, unpricedRecords: 0, partialRecords: 0, cacheUnpricedRecords: 0 } },
    ] },
    projects: { items: [] }, agentAttribution: { dimensions: { items: [] }, unattributed: { records: 0, observedTokens: 0 } },
    directUsage: { records: 0, observedTokens: 0 },
  }))
  const text = h.text("#providers-table")
  assert.match(text, /1\.00 USD/, "ordinary host cost survives malformed neighbors")
  const apiSlice = text.slice(text.indexOf("API equiv."))
  assert.doesNotMatch(apiSlice, /9\.00 USD/, "malformed block never renders")
  assert.match(text, /—/)
})

test("range totals come from backend aggregates incl. archived clock, never client sums", async () => {
  const h = await dimsHarness()
  h.render(dims({ apiEquivalent: apiEquivalent({ archivedUSD: null, archivedRecords: 0, scope: "retained-raw-records", currencies: [{ currency: "USD", estimatedAmount: 3.54 }], retainedUSD: 3.54 }) }))
  const stats = h.text("#providers-stats")
  assert.match(stats, /≈ 3\.54 USD/, "dated range total is the retained subtotal only")
  assert.doesNotMatch(stats, /9\.99|6\.45/)
})

test("missing projects/agentAttribution section aggregates render — while rows and ordinary costs stay", async () => {
  const h = await dimsHarness()
  h.render(dims({
    projects: { items: [{ projectID: "p1", projectName: "Alpha", sessions: 1, records: 1, observedTokens: 10, lastObservedAt: Date.now() }] },
    agentAttribution: { dimensions: { items: [{ agentID: "root", sessions: 1, records: 1, observedTokens: 10 }] }, unattributed: { records: 0, observedTokens: 0 } },
  }))
  const projStats = h.text("#projects-stats")
  assert.match(projStats, /API equivalent/)
  assert.match(projStats, /—/, "no projects.apiCosts → unknown, never 0.00")
  assert.match(projStats, /recorded API prices not reported for this range/)
  assert.match(h.text("#projects-table"), /10/, "ordinary project rows survive")
  const agentStats = h.text("#agents-stats")
  assert.match(agentStats, /API equivalent/)
  assert.match(agentStats, /—/, "no agentAttribution.apiCosts → unknown, never 0.00")
  assert.doesNotMatch(agentStats, /≈/)
  assert.match(h.text("#agents-table"), /10/, "ordinary agent rows survive")
})

test("switching to an empty range clears stale API totals from projects and agents stats", async () => {
  const h = await dimsHarness()
  h.render(dims())
  assert.match(h.text("#projects-stats"), /≈ 12\.00 USD/)
  assert.match(h.text("#agents-stats"), /≈ 1\.30 USD/)
  h.render(dims({
    projects: { items: [] },
    agentAttribution: { dimensions: { items: [] }, unattributed: { records: 0, observedTokens: 0 } },
  }))
  assert.doesNotMatch(h.text("#projects-stats"), /12\.00|≈/, "projects stats cleared with its table")
  assert.doesNotMatch(h.text("#agents-stats"), /1\.30|≈/, "agents stats cleared with its table")
  assert.match(h.text("#projects-table"), /No projects in this range/)
  assert.match(h.text("#agents-table"), /No agents in this range/)
})

test("agents range with only unattributed usage still renders its row and the API stat", async () => {
  const h = await dimsHarness()
  h.render(dims({
    agentAttribution: {
      dimensions: { items: [] },
      unattributed: { records: 3, observedTokens: 15, sessions: 1, lastObservedAt: Date.now(), apiCosts: componentCost({ total: 0.4 }) },
      apiCosts: componentCost({ total: 0.4, pricedRecords: 2, unpricedRecords: 1, partialRecords: 1 }),
    },
  }))
  const text = h.text("#agents-table")
  assert.doesNotMatch(text, /No agents in this range/)
  assert.match(text, /unattributed/)
  assert.match(text, /0\.40 USD/, "the unattributed row keeps its own api cost")
  assert.match(text, /No named agents in this range/, "foot explains there were no named rows")
  const stats = h.text("#agents-stats")
  assert.match(stats, /≈ 0\.40 USD/, "API stat renders from agentAttribution.apiCosts")
  assert.match(stats, /All agents incl\. unattributed · recorded API prices · not a bill/)
})

test("static wiring: headers in all four tables, quota spacing preserved, no network calls", async () => {
  const page = await readPage()
  assert.ok(page.includes("['Cache hit','num'],['Host cost','num'],['API equiv.','num'],['Errors','num']"), "providers header order")
  assert.ok(page.includes("['Tokens (observed)','num'],['API equiv.','num'],['Models',''],['Last seen','']]"), "projects and agents share the column order")
  assert.ok(page.includes("['Cached share','num'],['API equiv.','num']]"), "direct table header")
  assert.match(page, /API equivalent prices each step at its recorded API price/)
  const style = page.slice(page.indexOf("<style>"), page.indexOf("</style>"))
  assert.match(style, /#quota-providers,#quota-estimates\{margin-top:24px\}/)
  assert.match(style, /#quota-panel-estimates \.note\{margin-top:26px\}/)
  assert.match(style, /\.ledger-wrap\{overflow-x:auto\}/, "wrapper has its overflow rule")
  assert.ok(page.includes("mount('#providers-table',h('div',{class:'ledger-wrap'}"), "providers table mounted inside ledger-wrap")
  const h = await dimsHarness()
  h.render(dims())
  assert.equal(h.fetchCalls(), 0)
  runInContext('expandedProviders.add("prov/a");paintOverview()', h.context)
  const tree = collect(h.nodes.get("#providers-table"))
  assert.ok(tree.some(n => n.attributes?.class === "ledger-wrap"), "runtime wrapper around the providers table")
  assert.equal(tree.find(n => n.attributes?.colspan)?.attributes.colspan, "10", "expanded provider detail row still spans all 10 columns")
})
