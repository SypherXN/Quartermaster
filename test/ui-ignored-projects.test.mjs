import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { createContext, runInContext } from "node:vm"

const readPage = () => readFile(new URL("../web/index.html", import.meta.url), "utf8")
const findNode = (root, predicate) => {
  if (!root) return null
  if (predicate(root)) return root
  for (const child of root.children ?? []) {
    const hit = findNode(child, predicate)
    if (hit) return hit
  }
  return null
}

async function pageHarness(initial) {
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
  let resolveFetch = null
  const paths = []
  let lastBody = null
  const fetch = async (path, init) => {
    paths.push(path)
    if (path === "/api/dashboard") return new Promise(() => {})
    assert.equal(path, "/api/options")
    assert.equal(init?.method, "POST")
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
  const editor = () => findNode(nodes.get("#ignored-projects"), (entry) => entry.attributes?.id === "ignored-projects-input")
  const hint = () => findNode(nodes.get("#ignored-projects"), (entry) => entry.attributes?.id === "ignored-projects-hint")
  return {
    page, context, nodes, editor, hint,
    click: (selector) => nodes.get(selector)?.handlers.click?.(),
    load: () => runInContext("saved=JSON.parse(initial);revision=1;canWrite=true;show(saved)", context),
    type: (text) => {
      const field = editor()
      assert.ok(field, "the ignored project directories editor renders")
      field.value = text
      field.handlers.input?.()
    },
    field: (selector) => nodes.get(selector),
    requests: () => paths,
    body: () => lastBody,
    respond: (response) => resolveFetch(response),
    draft: () => JSON.parse(runInContext("JSON.stringify(draft)", context)),
  }
}

const baseOptions = {
  plans: { review: ["fixture/old"] },
  agents: { reviewer: "review" },
  workTypes: {},
  categories: { side: ["fixture/untouched"] },
  sharedRateLimits: [["fixture/a", "fixture/b"]],
  probeRateLimits: ["fixture/a"],
  providerCooldownMs: 60000,
}

test("settings renders the ignored directories editor, empty by default and with existing paths", async () => {
  const page = await readPage()
  const settings = page.slice(page.indexOf('id="panel-settings"'), page.indexOf('id="budget-readings"'))
  assert.match(settings, /id="ignored-projects"/)
  assert.ok(settings.indexOf('id="ignored-projects"') > settings.indexOf('id="limits"'), "editor sits after the settings summary")
  const fields = page.slice(page.indexOf('id="options-fields"'), page.indexOf("</fieldset>", page.indexOf('id="options-fields"')))
  assert.match(fields, /id="ignored-projects"/, "editor locks with the draft fieldset")

  const legacy = await pageHarness(baseOptions)
  legacy.load()
  assert.equal(legacy.editor().value, "")
  assert.equal(legacy.editor().getAttribute("aria-describedby"), "ignored-projects-hint")
  const hint = legacy.hint()
  assert.ok(hint, "the hint is rendered")
  assert.match(hint.textContent, /hides matching project directories currently listed here, and their descendants/)
  assert.match(hint.textContent, /including Sessions/)
  assert.match(hint.textContent, /Usage is still recorded and history is kept/)
  assert.match(hint.textContent, /Remove an entry to show it again/)
  assert.match(hint.textContent, /Budgets, routing and error counts are unchanged/)
  assert.match(hint.textContent, /Windows paths ignore case/)
  assert.match(hint.textContent, /An empty list ignores nothing/)

  const existing = await pageHarness({ ...baseOptions, ignoredProjectDirectories: ["C:/work/one", "/srv/two"] })
  existing.load()
  assert.equal(existing.editor().value, "C:/work/one\n/srv/two")
})

test("typing edits the shared draft and sends no API call before Apply", async () => {
  const harness = await pageHarness(baseOptions)
  harness.load()
  harness.type("  C:/work/one  \n\n/srv/two \r\n")
  assert.deepEqual(harness.requests(), [], "typing alone must not call the gateway")
  assert.deepEqual(harness.draft().ignoredProjectDirectories, ["C:/work/one", "/srv/two"])
})

test("Apply posts the edited paths with every other draft option preserved", async () => {
  const harness = await pageHarness({ ...baseOptions, ignoredProjectDirectories: ["C:/work/keep"] })
  harness.load()
  harness.type("C:/work/one\nC:/work/two")
  const pending = harness.click("#apply-options")
  assert.deepEqual(harness.requests(), ["/api/options"])
  assert.equal(harness.field("#options-fields").disabled, true, "the draft fieldset locks while saving")
  assert.equal(harness.field("#apply-options").disabled, true, "a pending save keeps Apply disabled")
  harness.click("#apply-options")
  assert.deepEqual(harness.requests(), ["/api/options"], "a second click must not start another save")
  harness.respond({
    ok: true,
    json: async () => ({ revision: 2, options: harness.body().options, writable: true, path: "fixture/settings.jsonc" }),
  })
  await pending
  assert.deepEqual(harness.body(), {
    options: { ...baseOptions, ignoredProjectDirectories: ["C:/work/one", "C:/work/two"] },
    revision: 1,
  })
  assert.equal(harness.field("#options-fields").disabled, false)
  assert.equal(harness.field("#apply-options").disabled, false)
  assert.match(harness.field("#options-status").textContent, /^Applied\. The current session is unchanged/)
})

test("a successful Apply refreshes an open dashboard once through the existing fetch path", async () => {
  const harness = await pageHarness(baseOptions)
  harness.load()
  runInContext("dashboardData={}", harness.context)
  harness.type("C:/work/one")
  const pending = harness.click("#apply-options")
  harness.respond({
    ok: true,
    json: async () => ({ revision: 2, options: harness.body().options, writable: true }),
  })
  await pending
  await Promise.resolve()
  assert.deepEqual(harness.requests(), ["/api/options", "/api/dashboard"], "one refresh, no poller")
})

test("Apply keeps a standalone imported report without fetching the dashboard", async () => {
  const harness = await pageHarness(baseOptions)
  harness.load()
  runInContext("currentReport={projectID:'imported'}", harness.context)
  harness.type("C:/work/one")
  const pending = harness.click("#apply-options")
  harness.respond({ ok: true, json: async () => ({ revision: 2, options: harness.body().options, writable: true }) })
  await pending
  assert.deepEqual(harness.requests(), ["/api/options"])
  assert.equal(runInContext("currentReport.projectID", harness.context), "imported")
})

test("read-only disables Apply while a failure keeps the edited paths", async () => {
  const harness = await pageHarness(baseOptions)
  harness.load()
  runInContext("canWrite=false;paintAccess()", harness.context)
  assert.equal(harness.field("#apply-options").disabled, true, "read-only disables Apply")
  runInContext("canWrite=true;paintAccess()", harness.context)
  assert.equal(harness.field("#apply-options").disabled, false)
  harness.type("C:/work/kept")
  const pending = harness.click("#apply-options")
  harness.respond({ ok: false, json: async () => ({ error: "Fixture failure" }) })
  await pending
  assert.equal(harness.field("#options-status").textContent, "Fixture failure")
  assert.deepEqual(harness.draft().ignoredProjectDirectories, ["C:/work/kept"], "a failed save keeps the draft")
  assert.equal(harness.field("#options-fields").disabled, false, "a failed save unlocks the fieldset")
  assert.equal(harness.field("#apply-options").disabled, false, "a failed save re-enables Apply")
})

test("removing every path applies an empty list", async () => {
  const harness = await pageHarness({ ...baseOptions, ignoredProjectDirectories: ["C:/work/one"] })
  harness.load()
  harness.type("")
  const pending = harness.click("#apply-options")
  harness.respond({ ok: true, json: async () => ({ revision: 2, options: harness.body().options, writable: true }) })
  await pending
  assert.deepEqual(harness.body().options.ignoredProjectDirectories, [])
})

test("invalid paths fail closed before any request", async () => {
  const harness = await pageHarness(baseOptions)
  harness.load()
  for (const value of ["relative/path", "C:/", "C:/work/*", "C:/work/../other", " //server/share "]) {
    harness.type(value)
    harness.click("#apply-options")
    assert.deepEqual(harness.requests(), [], `no save for ${JSON.stringify(value)}`)
    assert.match(harness.field("#options-status").textContent, /Ignored project director/, `${JSON.stringify(value)} is rejected`)
  }
})
