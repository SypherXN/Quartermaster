import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { createContext, runInContext } from "node:vm"

test("model performance shows independent coverage, measured zero, old reports and ranges", async () => {
  const page = await readFile(new URL("../web/index.html", import.meta.url), "utf8")
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1]
  const nodes = new Map()
  const node = () => ({
    children: [], textContent: "", value: "", attributes: {}, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(k, v) { this.attributes[k] = v }, getAttribute(k) { return this.attributes[k] ?? null },
    hasAttribute(k) { return k in this.attributes }, removeAttribute(k) { delete this.attributes[k] },
    append(...kids) { this.children.push(...kids) }, replaceChildren(...kids) { this.children = kids },
    addEventListener() {}, focus() {}, closest() { return null },
  })
  const document = {
    createElement: node, querySelector(key) { if (!nodes.has(key)) nodes.set(key, node()); return nodes.get(key) },
    querySelectorAll() { return [] }, getElementById(id) { return this.querySelector(`#${id}`) },
    visibilityState: "hidden", addEventListener() {},
  }
  const context = createContext({ document, fetch: () => new Promise(() => {}), addEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, setInterval() {}, clearInterval() {},
    location: { hash: "" }, window: { location: { hash: "" }, addEventListener() {} } })
  runInContext(script, context)
  const render = (items, range = "all") => runInContext(
    `activeRange=${JSON.stringify(range)};renderDashboard(${JSON.stringify({ apiVersion: 1, status: "ok", totals: {}, costs: {}, projectID: "fixture", generatedAt: Date.now(), cooldowns: [], dimensions: { items } })})`, context)
  const text = n => [n.textContent, ...n.children.map(text)].filter(Boolean).join(" ")
  const rows = () => {
    const find = n => [n, ...n.children.flatMap(find)]
    return find(nodes.get("#models-table")).filter(n => n.attributes.class === "project-row")
      .map(n => n.children.map(text))
  }
  const model = (value, performance) => ({ dimension: "model", value, records: 3, observedTokens: 10, performance })
  render([model("p/m", { medianOutputTokensPerSecond: 0, outputTokensPerSecondSamples: 2,
    medianObservedTtftMs: 150, p95ObservedTtftMs: 300, observedTtftSamples: 1 }),
  model("p/old"), { dimension: "provider", value: "p" }, model("", {})])
  assert.deepEqual(rows()[0].slice(-5), ["0 tok/s", "2", "150 ms", "300 ms", "1"])
  assert.deepEqual(rows()[1].slice(-5), ["—", "—", "—", "—", "—"])
  assert.equal(rows().length, 2)
  assert.match(text(nodes.get("#models-table")), /dispatch to the end of the provider response body.*includes startup and stream transport, excludes tool settlement.*not pure decode speed.*missing boundary means no rate.*host, not an exact provider measurement.*approximate/i)
  assert.match(text(nodes.get("#models-table")), /all history/)
  render([model("p/m", { medianOutputTokensPerSecond: 10, outputTokensPerSecondSamples: 0,
    medianObservedTtftMs: null, p95ObservedTtftMs: null, observedTtftSamples: 0 })], "24h")
  assert.deepEqual(rows()[0].slice(-5), ["—", "0", "—", "—", "0"])
  assert.match(text(nodes.get("#models-table")), /last 24 hours/)
  render([{ dimension: "provider", value: "p", records: 3, observedTokens: 10 },
    model("p/used"), { ...model("p/timing", { medianObservedTtftMs: 80, observedTtftSamples: 1 }), records: 0, observedTokens: 0 }])
  assert.equal(rows().length, 2)
  assert.match(rows()[1][0], /p\/timing.*timing only/)
  assert.deepEqual(rows()[1].slice(-3), ["80 ms", "—", "1"])
  assert.match(text(nodes.get("#models-stats")), /Models in use 1 /)
  runInContext('expandedProviders.add("p");paintProviders()', context)
  assert.match(text(nodes.get("#providers-table")), /p\/used/)
  assert.doesNotMatch(text(nodes.get("#providers-table")), /p\/timing/)
  render([{ ...model("p/timing", { observedTtftSamples: 1, medianObservedTtftMs: 80 }), records: 0, observedTokens: 0 }])
  assert.match(text(nodes.get("#models-stats")), /Models in use —/)
  assert.doesNotMatch(text(nodes.get("#models-stats")), /Top model p\/timing/)
  render([])
  assert.match(text(nodes.get("#models-table")), /No model data yet/)
})
