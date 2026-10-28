import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { createContext, runInContext } from "node:vm"

interface FakeNode {
  tag: string
  children: FakeNode[]
  textContent: string
  value: string
  checked?: boolean
  hidden?: boolean
  attributes?: Record<string, string>
  handlers?: Record<string, (event?: unknown) => void>
  setAttribute: (name: string, value: string) => void
  append: (...kids: FakeNode[]) => void
  replaceChildren: (...kids: FakeNode[]) => void
  addEventListener: (event: string, callback: () => void) => void
  click: () => void
}

const textOf = (node: FakeNode): string => [node.textContent, node.value, ...node.children.map(textOf)].filter(Boolean).join(" ")
const descendants = (node: FakeNode): FakeNode[] => [node, ...node.children.flatMap(descendants)]

async function pageContext(extra: Record<string, unknown> = {}) {
  const page = await readFile(new URL("../web/index.html", import.meta.url), "utf8")
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  const nodes = new Map<string, FakeNode>()
  const node = (tag: string): FakeNode => ({
    tag, children: [], textContent: "", value: "", attributes: {}, handlers: {},
    setAttribute(name, value) { this.attributes![name] = value },
    append(...kids) { this.children.push(...kids) },
    replaceChildren(...kids) { this.children = kids },
    addEventListener(event, callback) { this.handlers![event] = callback },
    click() { this.handlers?.click?.() },
  })
  const context = createContext({ ...extra, document: {
    createElement: node,
    querySelector(selector: string) {
      if (!nodes.has(selector)) nodes.set(selector, node(selector))
      return nodes.get(selector)!
    },
  } })
  runInContext(script, context)
  return { context, nodes }
}

test("bindings accept a typed plan name and plans can be filtered and categorized without changing the saved draft", async () => {
  const options = { plans: { review: ["fixture/one"], other: ["fixture/two"] }, agents: { orchestrator: "review" }, workTypes: { bug: "other" } }
  const storage = { value: null as string | null, writes: 0, getItem() { return this.value }, setItem(_key: string, next: string) { this.value = next; this.writes++ } }
  const { context, nodes } = await pageContext({ localStorage: storage, optionsJSON: JSON.stringify(options) })
  runInContext("show(JSON.parse(optionsJSON))", context)
  const savedDraft = runInContext("JSON.stringify(editedOptions())", context)
  runInContext("draft.agents.librarian='missing-plan';renderBoard()", context)
  const field = (selector: string, label: string) => descendants(nodes.get(selector)!).find(node => node.attributes?.["aria-label"] === label)!
  const binding = field("#agents", "agent orchestrator plan")
  assert.equal(binding.tag, "input")
  assert.equal(binding.value, "review")
  const menu = descendants(nodes.get("#agents")!).find(node => node.attributes?.class === "binding-menu" && node.attributes?.["aria-label"] === "agent orchestrator plans")!
  assert.equal(menu.hidden, true)
  binding.handlers!.focus()
  assert.equal(menu.hidden, false)
  assert.match(textOf(menu), /review/)
  assert.match(textOf(menu), /other/)
  binding.value = "oth"
  binding.handlers!.input()
  assert.match(textOf(menu), /other/)
  assert.doesNotMatch(textOf(menu), /review/)
  descendants(menu).find(node => node.textContent === "other")!.handlers!.mousedown()
  assert.equal(binding.value, "other")
  assert.equal(menu.hidden, true)
  assert.equal(descendants(nodes.get("#agents")!).some(node => node.tag === "datalist"), false)
  assert.equal(field("#agents", "orchestrator category").tag, "select")
  const missing = field("#agents", "agent librarian plan")
  assert.equal(missing.value, "missing-plan")
  assert.match(textOf(nodes.get("#agents")!), /Plan is not listed yet/)
  binding.value = "other"
  binding.handlers!.input()
  assert.equal(runInContext("draft.agents.orchestrator", context), "other")
  binding.value = "typed-plan"
  binding.handlers!.input()
  assert.equal(runInContext("draft.agents.orchestrator", context), "typed-plan")
  assert.match(textOf(nodes.get("#agents")!), /Plan is not listed yet/)
  const filter = field("#plan-tools", "Filter plans")
  filter.value = "two"
  filter.handlers!.input()
  const cards = () => nodes.get("#plans")!.children.filter(node => node.tag === "details")
  assert.equal(cards().find(card => card.attributes?.["data-search"]?.includes("review"))!.hidden, true)
  assert.equal(cards().find(card => card.attributes?.["data-search"]?.includes("fixture/two"))!.hidden, false)
  assert.equal(runInContext("JSON.stringify(draft.plans)", context), JSON.stringify(options.plans))
  field("#plan-tools", "New category name").value = "Normal"
  descendants(nodes.get("#plan-tools")!).find(node => node.textContent === "Add category")!.click()
  const saved = JSON.parse(storage.value!)
  assert.deepEqual(saved.categories, ["Normal"])
  assert.equal(saved.version, 1)
  const assign = field("#plans", "review category")
  assign.value = "Normal"
  assign.handlers!.change()
  assert.equal(JSON.parse(storage.value!).assignments.review, "Normal")
  field("#plan-tools", "Filter plans").value = ""
  field("#plan-tools", "Filter plans").handlers!.input()
  const headings = () => nodes.get("#plans")!.children.filter(node => node.tag === "h3")
  const headingLabel = (node: FakeNode) => textOf(descendants(node).find(child => child.attributes?.class === "category-toggle")!).replace(/[▾▸]/g, "").trim()
  assert.deepEqual(headings().map(headingLabel), ["Normal", "Uncategorized"])
  const normalHeading = headings().find(node => headingLabel(node) === "Normal")!
  const normalToggle = descendants(normalHeading).find(node => node.tag === "button")!
  assert.equal(normalToggle.attributes?.["aria-expanded"], "false")
  assert.equal(cards().find(card => card.attributes?.["data-search"]?.includes("review"))!.hidden, true)
  assert.equal(cards().find(card => card.attributes?.["data-search"]?.includes("fixture/two"))!.hidden, true)
  assert.equal(normalHeading.hidden, false)
  normalToggle.click()
  assert.equal(normalToggle.attributes?.["aria-expanded"], "true")
  assert.equal(cards().find(card => card.attributes?.["data-search"]?.includes("review"))!.hidden, false)
  assert.equal(cards().find(card => card.attributes?.["data-search"]?.includes("fixture/two"))!.hidden, true)
  normalToggle.click()
  assert.equal(normalToggle.attributes?.["aria-expanded"], "false")
  assert.equal(cards().find(card => card.attributes?.["data-search"]?.includes("review"))!.hidden, true)
  assert.equal(normalHeading.hidden, false)
  const byCategory = field("#plan-tools", "Filter by category")
  byCategory.value = "Normal"
  byCategory.handlers!.change()
  assert.equal(cards().find(card => card.attributes?.["data-search"]?.includes("review"))!.hidden, false)
  assert.equal(cards().find(card => card.attributes?.["data-search"]?.includes("fixture/two"))!.hidden, true)
  assert.equal(headings().find(node => headingLabel(node) === "Uncategorized")!.hidden, true)
  descendants(nodes.get("#plan-tools")!).find(node => node.textContent === "Remove category")!.click()
  assert.deepEqual(JSON.parse(storage.value!).categories, [])
  assert.deepEqual(JSON.parse(storage.value!).assignments, {})
  assert.equal(nodes.get("#plans")!.children.filter(node => node.tag === "h3").length, 0)
  field("#agent-tools", "New agent category").value = "Reviewers"
  descendants(nodes.get("#agent-tools")!).find(node => node.textContent === "Add category")!.click()
  assert.deepEqual(JSON.parse(storage.value!).categories, ["Reviewers"])
  const agentCategory = field("#agents", "orchestrator category")
  assert.equal(agentCategory.tag, "select")
  assert.equal(agentCategory.value, "")
  agentCategory.value = "Reviewers"
  agentCategory.handlers!.change()
  assert.equal(JSON.parse(storage.value!).assignments.orchestrator, "Reviewers")
  const agentHeadings = () => nodes.get("#agents")!.children.filter(node => node.tag === "h3")
  const agentHeadingLabel = (node: FakeNode) => textOf(descendants(node).find(child => child.attributes?.class === "category-toggle")!).replace(/[▾▸]/g, "").trim()
  const agentRows = () => nodes.get("#agents")!.children.filter(node => typeof node.attributes?.["data-search"] === "string")
  assert.deepEqual(agentHeadings().map(agentHeadingLabel), ["Reviewers", "Uncategorized"])
  const reviewersToggle = descendants(agentHeadings().find(node => agentHeadingLabel(node) === "Reviewers")!).find(node => node.attributes?.class === "category-toggle")!
  assert.equal(reviewersToggle.attributes?.["aria-expanded"], "false")
  assert.equal(agentRows().find(row => row.attributes?.["data-search"]?.includes("orchestrator"))!.hidden, true)
  assert.equal(agentHeadings().find(node => agentHeadingLabel(node) === "Reviewers")!.hidden, false)
  reviewersToggle.click()
  assert.equal(reviewersToggle.attributes?.["aria-expanded"], "true")
  assert.equal(agentRows().find(row => row.attributes?.["data-search"]?.includes("orchestrator"))!.hidden, false)
  assert.equal(agentRows().find(row => row.attributes?.["data-search"]?.includes("librarian"))!.hidden, true)
  const agentFilter = field("#agent-tools", "Filter agents")
  agentFilter.value = "missing"
  agentFilter.handlers!.input()
  assert.equal(agentHeadings().find(node => agentHeadingLabel(node) === "Reviewers")!.hidden, true)
  assert.equal(agentHeadings().find(node => agentHeadingLabel(node) === "Uncategorized")!.hidden, false)
  agentFilter.value = ""
  agentFilter.handlers!.input()
  const byAgentCategory = field("#agent-tools", "Filter agents by category")
  byAgentCategory.value = "Reviewers"
  byAgentCategory.handlers!.change()
  assert.equal(agentRows().find(row => row.attributes?.["data-search"]?.includes("orchestrator"))!.hidden, false)
  assert.equal(agentHeadings().find(node => agentHeadingLabel(node) === "Uncategorized")!.hidden, true)
  descendants(nodes.get("#agent-tools")!).find(node => node.textContent === "Remove category")!.click()
  assert.deepEqual(JSON.parse(storage.value!).categories, [])
  assert.deepEqual(JSON.parse(storage.value!).assignments, {})
  assert.equal(nodes.get("#agents")!.children.filter(node => node.tag === "h3").length, 0)
  assert.equal(runInContext("draft.workTypes.bug", context), "other")
  runInContext("delete draft.agents.librarian;draft.agents.orchestrator='review';draft.workTypes.bug='other'", context)
  assert.equal(runInContext("JSON.stringify(editedOptions())", context), savedDraft)
  storage.value = '{"version":1,"models":["not-categories"]}'
  storage.writes = 0
  runInContext("categoriesLoaded=false;ensureCategories()", context)
  assert.equal(storage.writes, 0)
  assert.equal(runInContext("categoryReady", context), false)
  runInContext("agentCategoriesLoaded=false;ensureAgentCategories()", context)
  assert.equal(storage.writes, 0)
  assert.equal(runInContext("agentCategoryReady", context), false)
})

test("plans and categories reorder by dragging, and a plan dropped on a category joins it", async () => {
  const plans = { alpha: ["fixture/a"], beta: ["fixture/b"], gamma: ["fixture/c"] }
  const storage = { value: null as string | null, getItem() { return this.value }, setItem(_key: string, next: string) { this.value = next } }
  const { context, nodes } = await pageContext({ localStorage: storage, optionsJSON: JSON.stringify({ plans }) })
  runInContext("show(JSON.parse(optionsJSON))", context)
  const field = (selector: string, label: string) => descendants(nodes.get(selector)!).find(node => node.attributes?.["aria-label"] === label)!
  const cardNamed = (name: string) => nodes.get("#plans")!.children.find(node => node.tag === "details" && node.attributes?.["data-search"]?.startsWith(`${name} `))!
  const headingNamed = (name: string) => nodes.get("#plans")!.children.find(node => node.tag === "h3" && textOf(node).includes(name))!
  const dragEvent = () => ({ preventDefault() {}, dataTransfer: { setData() {}, setDragImage() {} } })
  const dragHandle = (node: FakeNode) => descendants(node).find(child => child.attributes?.class === "drag-handle")!
  const categoryNames = () => JSON.parse(storage.value!).categories as string[]

  field("#plan-tools", "New category name").value = "Work"
  descendants(nodes.get("#plan-tools")!).find(node => node.textContent === "Add category")!.click()
  field("#plans", "gamma category").value = "Work"
  field("#plans", "gamma category").handlers!.change()
  assert.deepEqual(categoryNames(), ["Work"])

  dragHandle(cardNamed("alpha")).handlers!.dragstart(dragEvent())
  cardNamed("gamma").handlers!.drop(dragEvent())
  assert.equal(runInContext("JSON.stringify(Object.keys(draft.plans))", context), JSON.stringify(["beta", "alpha", "gamma"]))
  assert.equal(JSON.parse(storage.value!).assignments.alpha, "Work")

  field("#plan-tools", "New category name").value = "Home"
  descendants(nodes.get("#plan-tools")!).find(node => node.textContent === "Add category")!.click()
  field("#plans", "beta category").value = "Home"
  field("#plans", "beta category").handlers!.change()
  assert.deepEqual(categoryNames(), ["Work", "Home"])

  dragHandle(headingNamed("Home")).handlers!.dragstart(dragEvent())
  headingNamed("Work").handlers!.drop(dragEvent())
  assert.deepEqual(categoryNames(), ["Home", "Work"])
  assert.equal(runInContext("JSON.stringify(Object.keys(draft.plans))", context), JSON.stringify(["beta", "alpha", "gamma"]))

  descendants(headingNamed("Home")).find(node => node.attributes?.["aria-label"] === "Move Home category later")!.click()
  assert.deepEqual(categoryNames(), ["Work", "Home"])
  assert.equal(JSON.parse(storage.value!).assignments.alpha, "Work")
  assert.equal(JSON.parse(storage.value!).assignments.beta, "Home")
})

test("agents and agent categories reorder by dragging, and an agent dropped on a category joins it", async () => {
  const options = { plans: { a: ["fixture/a"], b: ["fixture/b"], c: ["fixture/c"] }, agents: { alpha: "a", beta: "b", gamma: "c" }, workTypes: { bug: "a" } }
  const storage = { value: null as string | null, key: "", getItem() { return this.value }, setItem(key: string, next: string) { this.key = key; this.value = next } }
  const { context, nodes } = await pageContext({ localStorage: storage, optionsJSON: JSON.stringify(options) })
  runInContext("show(JSON.parse(optionsJSON))", context)
  const field = (selector: string, label: string) => descendants(nodes.get(selector)!).find(node => node.attributes?.["aria-label"] === label)!
  const rowNamed = (name: string) => nodes.get("#agents")!.children.find(node => node.attributes?.["data-search"]?.startsWith(`${name} `))!
  const headingNamed = (name: string) => nodes.get("#agents")!.children.find(node => node.tag === "h3" && textOf(node).includes(name))!
  const dragEvent = () => ({ preventDefault() {}, dataTransfer: { setData() {}, setDragImage() {} } })
  const dragHandle = (node: FakeNode) => descendants(node).find(child => child.attributes?.class === "drag-handle")!
  const categoryNames = () => JSON.parse(storage.value!).categories as string[]

  field("#agent-tools", "New agent category").value = "Work"
  descendants(nodes.get("#agent-tools")!).find(node => node.textContent === "Add category")!.click()
  assert.equal(storage.key, "quartermaster.agent-categories.v1")
  field("#agents", "gamma category").value = "Work"
  field("#agents", "gamma category").handlers!.change()
  assert.deepEqual(categoryNames(), ["Work"])

  dragHandle(rowNamed("alpha")).handlers!.dragstart(dragEvent())
  rowNamed("gamma").handlers!.drop(dragEvent())
  assert.equal(runInContext("JSON.stringify(Object.keys(draft.agents))", context), JSON.stringify(["beta", "alpha", "gamma"]))
  assert.equal(JSON.parse(storage.value!).assignments.alpha, "Work")
  assert.equal(JSON.parse(storage.value!).assignments.gamma, "Work")

  field("#agent-tools", "New agent category").value = "Home"
  descendants(nodes.get("#agent-tools")!).find(node => node.textContent === "Add category")!.click()
  field("#agents", "beta category").value = "Home"
  field("#agents", "beta category").handlers!.change()
  assert.deepEqual(categoryNames(), ["Work", "Home"])

  dragHandle(headingNamed("Home")).handlers!.dragstart(dragEvent())
  headingNamed("Work").handlers!.drop(dragEvent())
  assert.deepEqual(categoryNames(), ["Home", "Work"])
  assert.equal(runInContext("JSON.stringify(Object.keys(draft.agents))", context), JSON.stringify(["beta", "alpha", "gamma"]))

  descendants(headingNamed("Home")).find(node => node.attributes?.["aria-label"] === "Move Home category later")!.click()
  assert.deepEqual(categoryNames(), ["Work", "Home"])
  assert.equal(JSON.parse(storage.value!).assignments.alpha, "Work")
  assert.equal(JSON.parse(storage.value!).assignments.beta, "Home")
  assert.equal(runInContext("JSON.stringify(Object.keys(draft.plans))", context), JSON.stringify(["a", "b", "c"]))
  assert.equal(runInContext("draft.workTypes.bug", context), "a")
  const saved = JSON.parse(runInContext("JSON.stringify(editedOptions())", context))
  assert.equal(saved.agents.alpha, "a")
  assert.equal(Object.hasOwn(saved, "categories"), false)
})

test("preferred models sort first inside their provider and the filter hides the rest", async () => {
  const page = await readFile(new URL("../web/index.html", import.meta.url), "utf8")
  assert.equal(/Saved shortlist/.test(page), false)
  const storage = { value: null as string | null, getItem() { return this.value }, setItem(_key: string, next: string) { this.value = next } }
  const { context, nodes } = await pageContext({ localStorage: storage, optionsJSON: JSON.stringify({}) })
  const catalog = { generatedAt: 0, providers: [
    { id: "alpha", name: "Alpha", models: [{ id: "one", name: "One" }, { id: "two", name: "Two" }, { id: "three", name: "Three" }] },
    { id: "beta", name: "Beta", models: [{ id: "four", name: "Four" }] },
  ] }
  runInContext(`catalogData=${JSON.stringify(catalog)};preferredModels=new Set(['alpha/three','alpha/two']);preferenceReady=true;paintCatalog()`, context)
  const groups = () => nodes.get("#catalog")!.children.filter(node => node.tag === "details")
  const names = (index: number) => groups()[index]!.children.filter(node => node.tag === "article")
    .map(node => descendants(node).find(child => child.tag === "strong")!.textContent)

  assert.deepEqual(names(0), ["Two", "Three", "One"])
  assert.deepEqual(names(1), ["Four"])
  assert.equal(descendants(groups()[0]!.children[1]!).some(node => node.textContent === "Preferred"), true)

  nodes.get("#preferred-filter")!.checked = true
  runInContext("paintCatalog()", context)
  assert.deepEqual(names(0), ["Two", "Three"])
  assert.equal(groups().length, 1)
  assert.match(textOf(nodes.get("#catalog")!), /Two/)
})

test("modules keep their own chain, cooldowns, and edits in the draft", async () => {
  const options = {
    plans: { review: ["fixture/a"] },
    modules: {
      "opr-jev": { cooldownMs: 300000, models: [{ id: "opencode/jev-1.13-free", cooldownMs: 900000 }, "opencode/jev-1.13"] },
      solo: { models: ["fixture/b"] },
    },
  }
  const storage = { value: null as string | null, getItem() { return this.value }, setItem(_key: string, next: string) { this.value = next } }
  const { context, nodes } = await pageContext({ localStorage: storage, optionsJSON: JSON.stringify(options) })
  runInContext("show(JSON.parse(optionsJSON))", context)
  const field = (label: string) => descendants(nodes.get("#modules")!).find(node => node.attributes?.["aria-label"] === label)!
  const card = (name: string) => nodes.get("#modules")!.children.find(node => node.tag === "details" && node.attributes?.["data-module"] === name)!

  assert.match(textOf(card("opr-jev")), /opencode\/jev-1\.13-free.*opencode\/jev-1\.13/)
  assert.equal(field("opr-jev module cooldown milliseconds").value, "300000")
  assert.equal(field("opr-jev module model cooldown 1").value, "900000")
  assert.equal(descendants(card("solo")).some(node => node.textContent === "Remove"), false)
  assert.equal(descendants(card("opr-jev")).filter(node => node.textContent === "Remove").length, 2)

  field("opr-jev module cooldown milliseconds").value = "450000"
  field("opr-jev module cooldown milliseconds").handlers!.input()
  assert.equal(runInContext("draft.modules['opr-jev'].cooldownMs", context), 450000)

  field("opr-jev module variant 2").value = "low"
  field("opr-jev module variant 2").handlers!.input()
  assert.deepEqual(JSON.parse(runInContext("JSON.stringify(draft.modules['opr-jev'].models[1])", context)), { id: "opencode/jev-1.13", variant: "low" })

  field("opr-jev module model cooldown 1").value = ""
  field("opr-jev module model cooldown 1").handlers!.input()
  assert.equal(runInContext("'cooldownMs' in draft.modules['opr-jev'].models[0]", context), false)
  assert.equal(runInContext("draft.modules['opr-jev'].models[0].id", context), "opencode/jev-1.13-free")

  const moduleField = (label: string) => descendants(nodes.get("#module-tools")!).find(node => node.attributes?.["aria-label"] === label)!
  moduleField("New module name").value = "extra"
  descendants(nodes.get("#module-tools")!).find(node => node.textContent === "Add module")!.click()
  assert.deepEqual(JSON.parse(runInContext("JSON.stringify(draft.modules.extra)", context)), { models: [""] })
  const saved = JSON.parse(runInContext("JSON.stringify(editedOptions())", context))
  assert.deepEqual(saved.modules["opr-jev"].cooldownMs, 450000)
  assert.deepEqual(saved.modules.solo, { models: ["fixture/b"] })
})
