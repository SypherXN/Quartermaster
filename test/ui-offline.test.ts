import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { createContext, runInContext } from "node:vm"
import { parseConfig } from "../src/config.ts"

const readPage = (name: string) => readFile(new URL(`../web/${name}`, import.meta.url), "utf8")

for (const name of ["toString", "constructor", "__proto__"]) {
  test(`assignment editor round-trips plans and bindings named ${name}`, async () => {
    const page = await readPage("index.html")
    const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    assert.ok(script)
    const options = {
      plans: Object.fromEntries([[name, ["fixture/primary", { id: "fixture/backup", variant: "fast" }]]]),
      agents: Object.fromEntries([[name, name], ["reviewer", name]]),
      workTypes: Object.fromEntries([[name, name], ["review", name]]),
      providerCooldownMs: 45000,
    }
    const context = createContext({
      optionsJSON: JSON.stringify(options),
      document: {
        querySelector: () => ({ value: "", addEventListener() {} }),
      },
    })
    runInContext(script, context)
    const edited = JSON.parse(runInContext(
      "saved=JSON.parse(optionsJSON);show(saved);JSON.stringify(editedOptions())",
      context,
    ))
    assert.deepEqual(edited, options)
    assert.deepEqual(parseConfig(edited), parseConfig(options))
  })
}

test("report viewer uses only the opt-in same-origin report endpoint", async () => {
  const page = await readPage("index.html")
  assert.match(page, /type="file"/)
  assert.match(page, /file\.text\(\)/)
  assert.match(page, /apiVersion!==1/)
  assert.match(page, /status!=='ok'/)
  assert.match(page, /pre\.textContent=JSON\.stringify/)
  assert.match(page, /id="live"/)
  assert.match(page, /fetch\('\/api\/report',\{cache:'no-store',credentials:'same-origin'\}\)/)
  assert.match(page, /fetch\('\/api\/options',\{cache:'no-store',credentials:'same-origin'\}\)/)
  assert.match(page, /fetch\('\/api\/options',\{method:'POST'/)
  assert.match(page, /token server-side/)
  assert.match(page, /Plans/)
  assert.match(page, /Availability/)
  assert.match(page, /label for="plans"/)
  assert.match(page, /label for="agents"/)
  assert.match(page, /label for="work-types"/)
  assert.match(page, /id="cancel-options"/)
  assert.match(page, /current session is unchanged/)
  assert.doesNotMatch(page, /password|OPENCODE_TOKEN/)
  assert.doesNotMatch(page, /\b(?:XMLHttpRequest|WebSocket|EventSource)\b/)
  assert.doesNotMatch(page, /fetch\((?!'\/api\/(?:report|options)')/)
})

test("assignment editor locks pending loads and saves, then restores Cancel on success or failure", async () => {
  const page = await readPage("index.html")
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  assert.match(page, /<fieldset id="options-fields" aria-labelledby="options-heading"/)
  const fields = page.match(/<fieldset[^>]*>([\s\S]*?)<\/fieldset>/)?.[1] ?? ""
  for (const id of ["plans", "agents", "work-types", "load-options", "apply-options", "cancel-options"]) {
    assert.ok(fields.includes(`id="${id}"`))
  }
  for (const action of ["load", "apply"]) for (const ok of [true, false]) {
    const elements = new Map<string, { value: string; textContent: string; disabled: boolean; addEventListener: (type: string, callback: () => unknown) => void }>()
    const handlers = new Map<string, () => unknown>()
    const element = (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, {
        value: "", textContent: "", disabled: false,
        addEventListener: (_type, callback) => { handlers.set(selector, callback) },
      })
      return elements.get(selector)!
    }
    const click = (selector: string) => {
      const handler = handlers.get(selector)
      assert.ok(handler)
      return handler()
    }
    const original = { plans: { review: ["fixture/old"] }, agents: {}, workTypes: {} }
    let persisted = original
    let requests = 0
    let finish!: () => void
    const context = createContext({
      initial: JSON.stringify(original), document: { querySelector: element },
      fetch: async (path: string, init?: { method?: string; body?: string }) => {
        assert.equal(path, "/api/options")
        requests++
        const proposed = init?.body ? JSON.parse(init.body).options : original
        return new Promise((resolve) => { finish = () => {
          if (ok && init?.method === "POST") persisted = proposed
          resolve({ ok, json: async () => ok ? { revision: 2, options: persisted } : { error: "Fixture failure" } })
        } })
      },
    })
    runInContext(script, context)
    runInContext('saved=JSON.parse(initial);revision=1;show(saved);plansInput.value="review fixture/draft"', context)
    click("#cancel-options")
    assert.equal(requests, 0)
    assert.equal(element("#plans").value, "review fixture/old")
    element("#plans").value = "review fixture/new"
    const pending = click(`#${action}-options`)
    assert.equal(element("#options-fields").disabled, true)
    const status = element("#options-status").textContent
    click("#cancel-options")
    await click("#load-options")
    await click("#apply-options")
    assert.equal(requests, 1)
    assert.equal(element("#options-status").textContent, status)
    assert.equal(element("#plans").value, "review fixture/new")
    assert.equal(persisted, original)
    finish()
    await pending
    assert.equal(element("#options-fields").disabled, false)
    assert.match(element("#options-status").textContent, ok ? /^(Loaded|Applied)/ : /Fixture failure/)
    assert.deepEqual(persisted.plans.review, [ok && action === "apply" ? "fixture/new" : "fixture/old"])
    element("#plans").value = "review fixture/another-draft"
    click("#cancel-options")
    assert.equal(requests, 1)
    assert.equal(element("#plans").value, ok ? `review ${persisted.plans.review[0]}` : action === "apply" ? "review fixture/old" : "review fixture/another-draft")
    assert.match(element("#options-status").textContent, !ok && action === "load" ? /^Nothing to cancel/ : /^Cancelled/)
  }
})

test("config page only downloads a syntax-checked JSON draft", async () => {
  const page = await readPage("config.html")
  assert.match(page, /JSON\.parse\(editor\.value\)/)
  assert.match(page, /Array\.isArray\(options\)/)
  assert.match(page, /quartermaster-options\.json/)
  assert.match(page, /does not connect to OpenCode or write files/)
  assert.match(page, /does not validate Quartermaster semantics or preserve JSONC comments/)
  assert.doesNotMatch(page, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/)
})
