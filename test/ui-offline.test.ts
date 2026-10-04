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

test("config page only downloads a syntax-checked JSON draft", async () => {
  const page = await readPage("config.html")
  assert.match(page, /JSON\.parse\(editor\.value\)/)
  assert.match(page, /Array\.isArray\(options\)/)
  assert.match(page, /quartermaster-options\.json/)
  assert.match(page, /does not connect to OpenCode or write files/)
  assert.match(page, /does not validate Quartermaster semantics or preserve JSONC comments/)
  assert.doesNotMatch(page, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/)
})
