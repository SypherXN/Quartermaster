import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { createContext, runInContext } from "node:vm"

const readPage = () => readFile(new URL("../web/index.html", import.meta.url), "utf8")
const textOf = (node) => [node.textContent, node.value, ...node.children.map(textOf)].filter(Boolean).join(" ")

async function applyHarness(initial) {
  const page = await readPage()
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  const nodes = new Map()
  const node = (key) => ({
    key, children: [], textContent: "", value: "", disabled: false, checked: false, type: "",
    attributes: {}, handlers: {}, hidden: false, open: false, tabIndex: 0, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value },
    getAttribute(name) { return this.attributes[name] ?? null },
    hasAttribute(name) { return name in this.attributes },
    removeAttribute(name) { delete this.attributes[name] },
    focus() {},
    closest() { return null },
    append(...kids) { this.children.push(...kids) },
    replaceChildren(...kids) { this.children = kids },
    addEventListener(type, callback) { this.handlers[type] = callback },
  })
  const groups = {
    ".apply-changes": ["#apply-options", "#apply-routing", "#apply-pools"],
    ".apply-status": ["#routing-apply-status", "#pool-apply-status"],
  }
  const doc = {
    createElement: () => node("fresh-" + Math.random()),
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, node(selector))
      return nodes.get(selector)
    },
    querySelectorAll(selector) {
      return (groups[selector] ?? []).map((key) => this.querySelector(key))
    },
    getElementById(id) { return this.querySelector(`#${id}`) },
    title: "",
    visibilityState: "hidden",
    addEventListener() {},
  }
  let requests = 0
  let lastBody = null
  let resolveFetch = null
  const fetch = async (path, init) => {
    assert.equal(path, "/api/options")
    assert.equal(init?.method, "POST")
    requests++
    lastBody = init?.body ? JSON.parse(init.body) : null
    return new Promise((resolve) => { resolveFetch = resolve })
  }
  const context = createContext({
    initial: JSON.stringify(initial),
    document: doc,
    fetch,
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    setInterval() { return 0 },
    clearInterval() {},
    window: { location: { hash: "" }, addEventListener() {} },
  })
  runInContext(script, context)
  return {
    page, context, nodes,
    click: (selector) => nodes.get(selector)?.handlers.click?.(),
    load: () => runInContext("saved=JSON.parse(initial);revision=1;canWrite=true;show(saved)", context),
    text: (selector) => textOf(nodes.get(selector)),
    requests: () => requests,
    body: () => lastBody,
    respond: (response) => resolveFetch(response),
    reset: () => { requests = 0; lastBody = null },
  }
}

const initialOptions = {
  plans: { review: ["fixture/old"] },
  agents: { reviewer: "review" },
  workTypes: {},
  categories: { side: ["fixture/untouched"] },
  sharedRateLimits: [["fixture/a", "fixture/b"]],
  probeRateLimits: ["fixture/a"],
  providerCooldownMs: 60000,
}

test("apply controls exist on routing categories and shared pools with accessible labels and unique ids", async () => {
  const page = await readPage()
  const categories = page.slice(page.indexOf('id="routing-panel-categories"'), page.indexOf('id="routing-groups"'))
  const details = page.slice(page.indexOf('id="shared-pools"'), page.indexOf('id="apply-pools"') + 400)
  for (const snippet of [categories, details]) {
    assert.match(snippet, /class="primary apply-changes" type="button" disabled>Apply changes<\/button>/)
    assert.match(snippet, /class="status-line apply-status" role="status" aria-live="polite">Edits stay in this browser draft/)
  }
  assert.match(page, /id="apply-options" class="primary apply-changes"/)
  assert.match(categories, /<fieldset id="category-fields" style="border:0;padding:0;margin:0;min-width:0">/)
  assert.match(categories, /<\/fieldset>/)
  assert.ok(categories.indexOf('id="category-fields"') < categories.indexOf('id="apply-routing"'), "apply sits in the category fieldset")
  assert.match(categories, /id="apply-routing"/)
  assert.match(details, /id="apply-pools"/)
  assert.doesNotMatch(page, /Apply plans/)
  const seen = new Set()
  for (const match of page.matchAll(/\sid="([^"]+)"/g)) {
    if (seen.has(match[1])) assert.fail(`duplicate element id: ${match[1]}`)
    seen.add(match[1])
  }
})

test("apply from Routing > Categories posts the whole draft with unrelated edits preserved and mirrors status", async () => {
  const harness = await applyHarness(initialOptions)
  harness.load()
  runInContext('setPlanModels("review", ["fixture/new"])', harness.context)
  runInContext('draft.categories.main=["fixture/cat-a"]', harness.context)
  const pending = harness.click("#apply-routing")
  assert.ok(pending)
  assert.equal(harness.requests(), 1)
  for (const selector of ["#apply-options", "#apply-routing", "#apply-pools"]) {
    assert.equal(harness.nodes.get(selector)?.disabled, true, `pending disables ${selector}`)
  }
  for (const selector of ["#options-status", "#routing-apply-status", "#pool-apply-status"]) {
    assert.match(harness.nodes.get(selector)?.textContent, /Applying changes…/)
  }
  harness.click("#apply-pools")
  assert.equal(harness.requests(), 1, "a second apply click while pending must not start another save")
  assert.equal(harness.nodes.get("#options-fields")?.disabled, true)
  assert.equal(harness.nodes.get("#category-fields")?.disabled, true, "category editor locks while the save is pending")
  harness.respond({
    ok: true,
    json: async () => ({ revision: 2, options: harness.body().options, writable: true, path: "fixture/settings.jsonc" }),
  })
  await pending
  assert.equal(harness.requests(), 1)
  assert.deepEqual(harness.body(), {
    options: {
      ...initialOptions,
      plans: { review: ["fixture/new"] },
      categories: { side: ["fixture/untouched"], main: ["fixture/cat-a"] },
    },
    revision: 1,
  })
  for (const selector of ["#apply-options", "#apply-routing", "#apply-pools"]) {
    assert.equal(harness.nodes.get(selector)?.disabled, false, `success re-enables ${selector}`)
  }
  assert.equal(harness.nodes.get("#category-fields")?.disabled, false, "success re-enables the category editor")
  for (const selector of ["#options-status", "#routing-apply-status", "#pool-apply-status"]) {
    assert.match(harness.nodes.get(selector)?.textContent, /^Applied\. The current session is unchanged/)
  }
})

test("apply from Providers > shared pools shows save errors, keeps the draft, and mirrors read-only state", async () => {
  const harness = await applyHarness(initialOptions)
  harness.load()
  runInContext('draft.sharedRateLimits=[["fixture/c","fixture/d"]]', harness.context)
  const pending = harness.click("#apply-pools")
  assert.equal(harness.requests(), 1)
  harness.respond({ ok: false, json: async () => ({ error: "Fixture failure" }) })
  await pending
  for (const selector of ["#options-status", "#routing-apply-status", "#pool-apply-status"]) {
    assert.equal(harness.nodes.get(selector)?.textContent, "Fixture failure")
  }
  for (const selector of ["#apply-options", "#apply-routing", "#apply-pools"]) {
    assert.equal(harness.nodes.get(selector)?.disabled, false, `failure re-enables ${selector}`)
  }
  assert.equal(harness.nodes.get("#category-fields")?.disabled, false, "failure re-enables the category editor")
  const draft = JSON.parse(runInContext("JSON.stringify(draft)", harness.context))
  assert.deepEqual(draft.sharedRateLimits, [["fixture/c", "fixture/d"]], "a failed save keeps draft edits")
  assert.deepEqual(
    JSON.parse(runInContext("JSON.stringify(saved)", harness.context)).sharedRateLimits,
    initialOptions.sharedRateLimits,
    "a failed save never replaces the saved options",
  )
  runInContext("canWrite=false;paintAccess()", harness.context)
  for (const selector of ["#apply-options", "#apply-routing", "#apply-pools"]) {
    assert.equal(harness.nodes.get(selector)?.disabled, true, `read-only disables ${selector}`)
  }
  runInContext("canWrite=true;paintAccess()", harness.context)
  for (const selector of ["#apply-options", "#apply-routing", "#apply-pools"]) {
    assert.equal(harness.nodes.get(selector)?.disabled, false, `writable re-enables ${selector}`)
  }
})
