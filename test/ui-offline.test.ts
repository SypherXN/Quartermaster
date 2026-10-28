import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { createContext, runInContext } from "node:vm"
import { parseConfig } from "../src/config.ts"

interface FakeNode {
  tag: string
  children: FakeNode[]
  textContent: string
  value: string
  disabled: boolean
  checked?: boolean
  open?: boolean
  type: string
  attributes?: Record<string, string>
  handlers?: Record<string, () => unknown>
  setAttribute: (name: string, value: string) => void
  append: (...kids: FakeNode[]) => void
  replaceChildren: (...kids: FakeNode[]) => void
  addEventListener: (event: string, callback: () => unknown) => void
  click: () => void
}

const textOf = (node: FakeNode): string => [node.textContent, node.value, ...node.children.map(textOf)].filter(Boolean).join(" ")

const readPage = (name: string) => readFile(new URL(`../web/${name}`, import.meta.url), "utf8")
const memoryStorage=(value:string|null=null)=>({value,writes:0,getItem(_key:string){return this.value},setItem(_key:string,next:string){this.value=next;this.writes++}})
const descendants=(node:FakeNode):FakeNode[]=>[node,...node.children.flatMap(descendants)]

async function dashboardContext(extra: Record<string, unknown> = {}) {
  const page = await readPage("index.html")
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  const nodes = new Map<string, FakeNode>()
  const node = (tag: string): FakeNode => ({
    tag, children: [], textContent: "", value: "", disabled: false, checked: false, type: "",
    attributes: {}, setAttribute(name, value) { this.attributes![name]=value }, append(...kids) { this.children.push(...kids) },
    replaceChildren(...kids) { this.children = kids }, handlers: {},
    addEventListener(event, callback) { this.handlers![event]=callback }, click() { this.handlers?.click?.() },
  })
  const context = createContext({ ...extra, document: {
    createElement: node,
    querySelector(selector: string) { if (!nodes.has(selector)) nodes.set(selector, node(selector)); return nodes.get(selector)! },
  } })
  runInContext(script, context)
  return { context, nodes, text: (selector: string) => textOf(nodes.get(selector)!) }
}

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
      modules: { opr: { cooldownMs: 12000, models: [{ id: "fixture/free", cooldownMs: 5000 }, "fixture/paid"] } },
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

test("brand uses a decorative supply chest beside the readable wordmark", async () => {
  const page = await readPage("index.html")
  const brand = page.match(/<a class="brand"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? ""
  assert.match(brand, /<svg aria-hidden="true" width="24" height="24"/)
  assert.match(brand, /<path d="M3 10h7m4 0h7M10 6v8h4V6"\/>/)
  assert.match(brand, /<\/svg><\/span>Quartermaster$/)
})

test("report viewer uses only the opt-in same-origin report endpoint", async () => {
  const page = await readPage("index.html")
  assert.match(page, /type="file"/)
  assert.match(page, /file\.text\(\)/)
  assert.match(page, /apiVersion!==1/)
  assert.match(page, /status!=='ok'/)
  assert.doesNotMatch(page, /pre\.textContent=JSON\.stringify/)
  assert.match(page, /id="live"/)
  assert.match(page, /fetch\('\/api\/report',\{cache:'no-store',credentials:'same-origin'\}\)/)
  assert.match(page, /fetch\('\/api\/options',\{cache:'no-store',credentials:'same-origin'\}\)/)
  assert.match(page, /fetch\('\/api\/options',\{method:'POST'/)
  assert.match(page, /token server-side/)
  assert.match(page, /Plans/)
  assert.match(page, /Observed tokens/)
  assert.match(page, /label for="plans"/)
  assert.match(page, /label for="agents"/)
  assert.match(page, /id="agent-tools"/)
  assert.doesNotMatch(page, /id="work-types"/)
  assert.match(page, /id="cancel-options"/)
  assert.match(page, /current session is unchanged/)
  assert.doesNotMatch(page, /password|OPENCODE_TOKEN/)
  assert.doesNotMatch(page, /\b(?:XMLHttpRequest|WebSocket|EventSource)\b/)
  assert.doesNotMatch(page, /fetch\((?!['`]\/api\/(?:report|options|dashboard|providers))/)
})

test("assignment editor locks pending loads and saves, then restores Cancel on success or failure", async () => {
  const page = await readPage("index.html")
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  assert.match(page, /<fieldset id="options-fields" aria-labelledby="options-heading"/)
  const fields = page.match(/<fieldset[^>]*>([\s\S]*?)<\/fieldset>/)?.[1] ?? ""
  for (const id of ["plans", "agents", "agent-tools", "load-options", "apply-options", "cancel-options"]) {
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
          resolve({ ok, json: async () => ok ? { revision: 2, options: persisted, writable: true } : { error: "Fixture failure" } })
        } })
      },
    })
    runInContext(script, context)
    const review = () => JSON.parse(runInContext("JSON.stringify(draft.plans.review)", context)) as string[]
    runInContext('saved=JSON.parse(initial);revision=1;canWrite=true;show(saved);setPlanModels("review", ["fixture/draft"])', context)
    click("#cancel-options")
    assert.equal(requests, 0)
    assert.deepEqual(review(), ["fixture/old"])
    runInContext('setPlanModels("review", ["fixture/new"])', context)
    const pending = click(`#${action}-options`)
    assert.equal(element("#options-fields").disabled, true)
    const status = element("#options-status").textContent
    click("#cancel-options")
    await click("#load-options")
    await click("#apply-options")
    assert.equal(requests, 1)
    assert.equal(element("#options-status").textContent, status)
    assert.deepEqual(review(), ["fixture/new"])
    assert.equal(persisted, original)
    finish()
    await pending
    assert.equal(element("#options-fields").disabled, false)
    assert.match(element("#options-status").textContent, ok ? /^(Loaded|Applied)/ : /Fixture failure/)
    assert.deepEqual(persisted.plans.review, [ok && action === "apply" ? "fixture/new" : "fixture/old"])
    runInContext('setPlanModels("review", ["fixture/another-draft"])', context)
    click("#cancel-options")
    assert.equal(requests, 1)
    const expected = !ok && action === "load" ? ["fixture/another-draft"] : !ok ? ["fixture/old"] : persisted.plans.review
    assert.deepEqual(review(), expected)
    assert.match(element("#options-status").textContent, !ok && action === "load" ? /^Nothing to cancel/ : /^Cancelled/)
  }
})

test("plan board keeps a multi-word variant and the shared pool", async () => {
  const page = await readPage("index.html")
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  const options = {
    plans: { review: ["cursor/composer-2.5", { id: "cursor/grok-4.7", variant: "Grok 4.7 High" }] },
    agents: { reviewer: "review" },
    workTypes: {},
    sharedRateLimits: [["opencode/glm-5.3-flash-free", "cursor/grok-4.7"]],
    probeRateLimits: ["opencode/glm-5.3-flash-free", { id: "cursor/grok-4.7", variant: "Grok 4.7 High" }],
    providerCooldownMs: 60000,
  }
  const nodes = new Map<string, FakeNode>()
  const node = (tag: string): FakeNode => ({
    tag,
    children: [],
    textContent: "",
    value: "",
    disabled: false,
    type: "",
    setAttribute() {},
    append(...kids: FakeNode[]) { this.children.push(...kids) },
    replaceChildren(...kids: FakeNode[]) { this.children = kids },
    addEventListener() {},
    click() {},
  })
  const document = {
    createElement: (tag: string) => node(tag),
    querySelector(selector: string) {
      if (!nodes.has(selector)) nodes.set(selector, node(selector))
      return nodes.get(selector)!
    },
  }
  const context = createContext({ optionsJSON: JSON.stringify(options), document })
  runInContext(script, context)
  const edited = JSON.parse(runInContext("show(JSON.parse(optionsJSON));JSON.stringify(editedOptions())", context))
  assert.deepEqual(edited, options)
  assert.deepEqual(parseConfig(edited), parseConfig(options))
  const visible = textOf(nodes.get("#plans")!)
  assert.match(visible, /cursor\/grok-4\.7/)
  assert.match(visible, /Grok 4\.7 High/)
  assert.match(visible, /shared pool/)
  assert.match(visible, /probe/)
  assert.match(textOf(nodes.get("#probes")!), /More than one probe sits in the same shared pool/)
  runInContext("canWrite=false;paintAccess()", context)
  assert.equal(nodes.get("#apply-options")!.disabled, true)
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

test("missing, false, and non-boolean writable metadata cannot enable project saves", async () => {
  const page = await readPage("index.html")
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  for (const writable of [undefined, false, "true", 1, true]) {
    const handlers = new Map<string, () => unknown>()
    const nodes = new Map<string, { disabled: boolean; textContent: string; addEventListener: (event: string, callback: () => unknown) => void }>()
    let posts = 0
    const context = createContext({
      document: { querySelector(selector: string) {
        if (!nodes.has(selector)) nodes.set(selector, { disabled: false, textContent: "", addEventListener(_event, callback) { handlers.set(selector, callback) } })
        return nodes.get(selector)!
      } },
      fetch: async (_path: string, init?: { method?: string }) => {
        if (init?.method === "POST") posts++
        return { ok: true, json: async () => ({ revision: 1, writable, options: { plans: { work: ["fixture/model"] } } }) }
      },
    })
    runInContext(script, context)
    assert.equal(runInContext("canWrite", context), false)
    await handlers.get("#load-options")!()
    assert.equal(nodes.get("#apply-options")!.disabled, writable !== true)
    await handlers.get("#apply-options")!()
    assert.equal(posts, writable === true ? 1 : 0)
  }
})

test("host chain summaries retain providerID/modelID and exact multiword variants", async () => {
  const page = await readPage("index.html")
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  const context = createContext({ document: { querySelector: () => ({ addEventListener() {} }) } })
  runInContext(script, context)
  assert.equal(runInContext('chainText([{providerID:"cursor",modelID:"grok-4.7",variant:"Grok 4.7 High"}, "fixture/fallback"])', context), "cursor/grok-4.7 · Grok 4.7 High → fixture/fallback")
})

test("dashboard empty states never guess quota percentages, costs, or reset times", async () => {
  const { context, text } = await dashboardContext()
  runInContext("paintOverview();paintCatalog();paintUsage()", context)
  assert.match(text("#overview-stats"), /Observed tokens —/)
  assert.match(text("#overview-chart"), /A little quiet/)
  assert.match(text("#catalog"), /model library awaits/)
  assert.match(text("#quota-providers"), /No quota snapshot yet/)
  assert.doesNotMatch(text("#quota-providers"), /\d+%|\d{1,2}:\d{2}/)
})

test("catalog separates thinking capability from exact, multiword named variants", async () => {
  const fixture = { generatedAt: 1780000000000, providers: [{ id: "fixture", name: "Fixture", models: [
    { id: "reasoner", name: "Reasoner", reasoning: true, context: 128000, variants: ["Grok 4.7 High", "High fast"] },
    { id: "plain", name: "Plain", reasoning: false, variants: [] },
  ] }] }
  const { context, nodes, text } = await dashboardContext({ fixture: JSON.stringify(fixture) })
  runInContext("catalogData=JSON.parse(fixture);paintCatalog();catalogSuggestions()", context)
  assert.match(text("#catalog"), /Grok 4\.7 High/)
  assert.match(text("#catalog"), /No named variants advertised/)
  assert.doesNotMatch(text("#catalog"), /medium|xhigh/)
  nodes.get("#model-search")!.value = "high fast"
  runInContext("paintCatalog()", context)
  assert.match(text("#catalog"), /Reasoner/)
  assert.doesNotMatch(text("#catalog"), /Plain/)
  assert.match(text("#model-suggestions"), /fixture\/reasoner/)
})

test("usage distinguishes partial telemetry, stale quota resets, and QM cooldowns", async () => {
  const fixture = {
    report: { apiVersion: 1, status: "ok", projectID: "fixture-project", generatedAt: 1780000000000,
      totals: { records: 3, observedTokens: 1400, unknownTokenRecords: 1 },
      dimensions: { items: [{ dimension: "provider", value: "fixture", records: 3, observedTokens: 1400, unknownRecords: 1 }] },
      costs: { unpricedRecords: 3, currencies: [] }, plans: {} },
    usage: [{ providerID: "fixture", status: "available", stale: true, observedAt: 1780000000000,
      windows: [{ label: "Session window", percent: 42, resetsAt: 1780003600000 }],
      cooldownsKnown: true, cooldowns: [{ modelID: "fixture/model", until: 1780000060000 }] }],
  }
  const { context, text } = await dashboardContext({ fixture: JSON.stringify(fixture) })
  runInContext("const f=JSON.parse(fixture);usageData=f.usage;render(f.report)", context)
  const usage = text("#quota-providers")
  assert.doesNotMatch(usage, /1,400|unknown token counts|Quartermaster cooldowns|fixture\/model/)
  assert.match(usage, /Stale quota/)
  assert.match(usage, /42% used/)
  assert.match(usage, /Provider reset ·/)
  assert.match(usage, /STALE/)
  runInContext('usageData=[{providerID:"fixture",status:"unsupported",reason:"No provider quota source",windows:[],cooldownsKnown:true,cooldowns:[]}];paintUsage()', context)
  assert.match(text("#quota-providers"), /unsupported/)
  assert.match(text("#quota-providers"), /No provider quota source/)
  assert.doesNotMatch(text("#quota-providers"), /\d+%/)
})

test("dashboard has four accessible hash views and no automatic network or unsafe HTML writes", async () => {
  const page = await readPage("index.html")
  for (const route of ["overview", "plans", "providers", "quota"]) {
    assert.match(page, new RegExp(`href="#${route}"`))
    assert.match(page, new RegExp(`data-page="${route}"`))
  }
  assert.match(page, /prefers-reduced-motion/)
  assert.match(page, /hashchange/)
  assert.match(page, /function renderDashboard/)
  assert.match(page, /function renderCatalog/)
  assert.match(page, /Skip to content/)
  assert.doesNotMatch(page, /innerHTML|setInterval|https?:\/\/|<script[^>]+src=/)
})

test("catalog adapter keeps exact variant names and does not invent effort", async () => {
  const { context, nodes, text } = await dashboardContext()
  runInContext(`renderCatalog({generatedAt:1780000000000,providers:[{id:"fixture",name:"Fixture",models:{reasoner:{name:"Reasoner",capabilities:{reasoning:true},variants:{"Grok 4.7 High":{effort:"high"},"High fast":{}}},plain:{name:"Plain",reasoning:false,variants:{}}}}]})`, context)
  assert.match(text("#catalog"), /Grok 4\.7 High/)
  assert.match(text("#catalog"), /High fast/)
  assert.match(text("#catalog"), /No named variants advertised/)
  assert.doesNotMatch(text("#catalog"), /effort|medium|xhigh/)
  assert.match(text("#model-suggestions"), /fixture\/reasoner/)
  nodes.get("#thinking-filter")!.checked = true
  runInContext("paintCatalog()", context)
  assert.match(text("#catalog"), /Reasoner/)
  assert.doesNotMatch(text("#catalog"), /Plain/)
})

test("dashboard adapter maps quota windows separately from cooldowns and omits unknown percents", async () => {
  const dashboard = {
    generatedAt: 1780000000000,
    report: { apiVersion: 1, status: "ok", projectID: "fixture-project", generatedAt: 1780000000000,
      totals: { records: 3, observedTokens: 1400, unknownTokenRecords: 1 },
      dimensions: { items: [{ dimension: "provider", value: "fixture", records: 3, observedTokens: 1400, unknownRecords: 1 }] },
      costs: { unpricedRecords: 3, currencies: [] },
      plans: { review: [{ providerID: "cursor", modelID: "grok-4.7", variant: "Grok 4.7 High" }] },
      agents: { reviewer: "review" }, workTypes: {} },
    availability: { status: "ok", updatedAt: 1780000000000, sources: { fixture: {
      sourceID: "cursor", stale: true, checkedAt: 1780000000000, availability: "limited",
      windows: [{ name: "Session window", usedPercent: 42, state: "rate-limited", resetsAt: 1780003600000 }],
    } } },
    cooldowns: [{ providerID: "fixture", modelID: "fixture/model", until: 1780000060000 }],
  }
  const { context, text } = await dashboardContext({ fixture: JSON.stringify(dashboard) })
  runInContext("renderDashboard(JSON.parse(fixture))", context)
  assert.match(text("#overview-plans"), /cursor\/grok-4\.7 · Grok 4\.7 High/)
  assert.match(text("#overview-plans"), /1 agent binding/)
  assert.doesNotMatch(text("#overview-stats"), /\{/)
  const usage = text("#quota-providers")
  assert.doesNotMatch(usage, /1,400|Quartermaster cooldowns|fixture\/model/)
  assert.match(usage, /42% used/)
  assert.match(usage, /Provider reset ·/)
  assert.match(usage, /Window state · rate-limited/)
  assert.match(usage, /Stale quota/)
  runInContext(`renderDashboard({report:JSON.parse(fixture).report,availability:{status:"unsupported",reason:"No provider quota source",sources:{fixture:{availability:"unsupported",windows:[{name:"Session",usedPercent:null,resetsAt:null}]}}}})`, context)
  assert.match(text("#quota-providers"), /unsupported/)
  assert.match(text("#quota-providers"), /No provider quota source/)
  assert.match(text("#quota-providers"), /Usage unknown/)
  assert.match(text("#quota-providers"), /Provider reset · unknown/)
  assert.doesNotMatch(text("#quota-providers"), /\d+%/)
})

test("report:null clears old imported telemetry but preserves current status plans and project", async () => {
  const { context, text } = await dashboardContext()
  runInContext(`render({apiVersion:1,status:'ok',projectID:'old-import',generatedAt:1780000000000,totals:{records:9,observedTokens:987654,unknownTokenRecords:0},costs:{currencies:[{currency:'USD',estimatedAmount:42}]},plans:{old:['old/model']}})`, context)
  runInContext(`renderDashboard({apiVersion:1,projectID:'current-project',generatedAt:1780003600000,plans:{current:[{providerID:'fixture',modelID:'primary',variant:'Exact High'}]},agents:{reviewer:'current'},workTypes:{review:'current'},availability:{status:'ok',sources:{fixture:{availability:'available',stale:false,checkedAt:1780000000000,windows:[{name:'Session',usedPercent:23,resetsAt:null}]}}},report:null,reportError:'Telemetry reporting is unsupported by this host.',cooldowns:[]})`, context)
  assert.equal(runInContext("currentReport", context), null)
  assert.match(text("#project-label"), /current-project/)
  assert.match(text("#overview-plans"), /fixture\/primary · Exact High/)
  assert.match(text("#overview-plans"), /1 agent binding/)
  assert.match(text("#overview-plans"), /1 work type/)
  assert.doesNotMatch(text("#overview-plans"), /old\/model/)
  assert.match(text("#overview-stats"), /Observed tokens — Telemetry unavailable/)
  assert.match(text("#overview-stats"), /Routing plans 1/)
  for (const selector of ["#status", "#overview-attention", "#dashboard-status"]) {
    assert.match(text(selector), /unsupported by this host/)
  }
  assert.match(text("#quota-providers"), /23% used/)
  assert.doesNotMatch(text("#quota-providers"), /987,654|42 USD/)
  runInContext(`renderCatalog({apiVersion:1,generatedAt:1780003600000,providers:[{id:'catalog-only',name:'Metadata only',models:[{id:'model',name:'Model',variants:[]}]}]})`, context)
  assert.match(text("#overview-stats"), /Catalog providers 1/)
  assert.match(text("#project-label"), /current-project/)
  assert.doesNotMatch(text("#quota-providers"), /Metadata only|No quota reading|No active cooldowns/)
})

test("loading catalog updates existing variant suggestions without rebuilding or discarding edits", async () => {
  const { context, nodes, text } = await dashboardContext()
  runInContext(`show({plans:{review:[{id:'fixture/reasoner',variant:'Custom'}]},agents:{},workTypes:{}})`, context)
  const card=nodes.get("#plans")!.children[0]
  const descendants=(node: FakeNode): FakeNode[] => [node,...node.children.flatMap(descendants)]
  const choices=descendants(card).find(node=>node.tag==='datalist')!
  const variant=descendants(card).find(node=>node.tag==='input'&&node.value==='Custom')!
  variant.value='Unsaved custom variant'
  runInContext(`writeModel('review',0,'fixture/reasoner','Unsaved custom variant');renderCatalog({apiVersion:1,generatedAt:1780000000000,providers:[{id:'fixture',name:'Fixture',models:[{id:'reasoner',name:'Reasoner',reasoning:true,variants:['Grok 4.7 High','High fast']}]}]})`, context)
  assert.equal(nodes.get("#plans")!.children[0],card)
  assert.match(textOf(choices), /Grok 4\.7 High/)
  assert.match(textOf(choices), /High fast/)
  assert.equal(variant.value,'Unsaved custom variant')
  assert.equal(runInContext("draft.plans.review[0].variant", context),'Unsaved custom variant')
  assert.doesNotMatch(text("#quota-providers"), /Fixture/)
})

test("large plan boards start compact while retaining each ordered chain preview", async () => {
  const plans=Object.fromEntries(Array.from({length:18},(_,index)=>[`plan-${index+1}`,["fixture/first",{id:"fixture/fallback",variant:"Exact High"}]]))
  const { context, nodes }=await dashboardContext({fixture:JSON.stringify({plans,agents:{},workTypes:{}})})
  runInContext("show(JSON.parse(fixture))",context)
  const cards=nodes.get("#plans")!.children.filter(node=>node.tag==='details')
  assert.equal(cards.length,18)
  assert.equal(cards.filter(node=>Object.hasOwn(node.attributes!,'open')).length,1)
  for(const card of cards){
    assert.equal(card.children[0].tag,'summary')
    assert.match(textOf(card.children[0]),/fixture\/first → fixture\/fallback · Exact High/)
  }
})

test("thinking badge reads known effort ids and leaves other names unknown", async () => {
  const { context, nodes, text }=await dashboardContext()
  runInContext(`renderCatalog({apiVersion:1,generatedAt:1780000000000,providers:[{id:'fixture',name:'Fixture',models:[{id:'enabled',name:'Enabled model',enabled:true,variants:['none','minimal','low','medium','high','xhigh','max']},{id:'cursor-model',name:'Cursor model',variants:['Claude Opus 5 High Fast','Claude Opus 5 1M No Thinking']},{id:'disabled',name:'Disabled model',enabled:false,variants:['Reasoning']},{id:'unknown',name:'Unknown model',variants:['Exact multiword effort']}]}]})`,context)
  const visible=text("#catalog")
  assert.match(visible,/Thinking · none–max/)
  assert.match(visible,/Thinking · none · high/)
  assert.equal((visible.match(/Thinking unknown/g)||[]).length,2)
  assert.match(visible,/Enabled/)
  assert.match(visible,/Disabled/)
  assert.match(visible,/Enabled unknown/)
  assert.doesNotMatch(visible,/No thinking/)
  assert.deepEqual(JSON.parse(runInContext("JSON.stringify(catalogModels().map(model=>model.enabled??null))",context)),[true,null,false,null])
  assert.deepEqual(JSON.parse(runInContext("JSON.stringify(catalogModels()[0].variants)",context)),['none','minimal','low','medium','high','xhigh','max'])
  nodes.get("#thinking-filter")!.checked=true
  runInContext("paintCatalog()",context)
  assert.match(text("#catalog"),/Enabled model/)
  assert.match(text("#catalog"),/Cursor model/)
  assert.doesNotMatch(text("#catalog"),/Disabled model|Unknown model/)
  assert.match(text("#model-suggestions"),/fixture\/enabled/)
  runInContext(`renderDashboard({apiVersion:1,projectID:'fixture',generatedAt:1780000000000,plans:{},agents:{},workTypes:{},report:null,availability:{status:'unconfigured',sources:{}}})`,context)
  for(const selector of ['#dashboard-status','#quota-status']){
    assert.match(text(selector),/No inference or recovery probes/)
    assert.match(text(selector),/rereading does not guarantee new observations/)
    assert.doesNotMatch(text(selector),/force a new|rereads cached state/)
  }
})

test("provider browser selects providers, scopes search, and retains exact model metadata", async () => {
  const fixture={apiVersion:1,generatedAt:1780000000000,providers:[
    {id:'alpha',name:'Amber',models:[{id:'primary',name:'Primary',enabled:true,limit:{context:128000,output:8192},variants:['Exact Multiword']},{id:'plain',name:'Plain',reasoning:false,variants:[]}]},
    {id:'beta',name:'Birch',models:[{id:'composer',name:'Composer',enabled:false,reasoning:true,variants:['Grok 4.7 High']}]},
    {id:'empty',name:'Empty provider',models:[]},
  ]}
  const {context,nodes,text}=await dashboardContext({fixture:JSON.stringify(fixture)})
  runInContext('renderCatalog(JSON.parse(fixture))',context)
  assert.equal(nodes.get('#provider-filter')!.value,'alpha')
  assert.equal(text('#catalog-heading'),'Amber')
  assert.match(text('#catalog-result'),/2 of 2 matching models loaded · 2 in this provider/)
  assert.match(text('#catalog'),/128,000 tokens/)
  assert.match(text('#catalog'),/8,192 tokens/)
  assert.match(text('#catalog'),/Thinking unknown/)
  assert.match(text('#catalog'),/No thinking/)
  assert.doesNotMatch(text('#catalog'),/Composer/)
  const providers=nodes.get('#provider-list')!.children
  const birch=providers.find(node=>node.attributes?.['aria-label']==='Birch, 1 matching models of 1')!
  assert.ok(birch)
  birch.click()
  assert.equal(nodes.get('#provider-filter')!.value,'beta')
  assert.equal(text('#catalog-heading'),'Birch')
  assert.match(text('#catalog'),/beta\/composer/)
  assert.match(text('#catalog'),/Grok 4\.7 High/)
  assert.match(text('#catalog'),/Disabled/)
  assert.match(text('#catalog'),/Context window Unknown/)
  assert.doesNotMatch(text('#catalog'),/alpha\/primary/)
  nodes.get('#model-search')!.value='Exact Multiword'
  runInContext('paintCatalog()',context)
  assert.match(text('#catalog'),/No models match/)
  assert.match(text('#catalog-result'),/0 of 0 matching models loaded · 1 in this provider/)
  runInContext("chooseProvider('')",context)
  assert.match(text('#catalog'),/alpha\/primary/)
  assert.doesNotMatch(text('#catalog'),/beta\/composer/)
  nodes.get('#model-search')!.value='beta/composer'
  runInContext('paintCatalog()',context)
  assert.match(text('#catalog'),/Grok 4\.7 High/)
  assert.match(text('#catalog-result'),/1 of 1 matching models loaded · 3 in this catalog/)
  nodes.get('#model-search')!.value='BIRCH'
  runInContext('paintCatalog()',context)
  assert.match(text('#catalog'),/beta\/composer/)
  assert.doesNotMatch(text('#catalog'),/alpha\/primary/)
  nodes.get('#model-search')!.value=''
  runInContext("chooseProvider('empty')",context)
  assert.match(text('#catalog'),/No models listed/)
  assert.equal(text('#catalog-heading'),'Empty provider')
  runInContext('renderCatalog(JSON.parse(fixture))',context)
  assert.equal(nodes.get('#provider-filter')!.value,'empty')
})

test("large catalogs reveal models locally in batches and reset the batch after search", async () => {
  const models=Array.from({length:65},(_,index)=>({id:`model-${index}`,name:`Model ${index}`,variants:[`Exact variant ${index}`]}))
  let requests=0
  const {context,nodes,text}=await dashboardContext({fixture:JSON.stringify({providers:[{id:'large',name:'Large catalog',models}]}),fetch:()=>{requests++;throw Error('No network expected')}})
  runInContext('renderCatalog(JSON.parse(fixture))',context)
  const descendants=(node:FakeNode):FakeNode[]=>[node,...node.children.flatMap(descendants)]
  const rows=()=>descendants(nodes.get('#catalog')!).filter(node=>node.attributes?.class==='model-entry')
  assert.equal(rows().length,30)
  assert.equal(rows().filter(node=>Object.hasOwn(node.attributes!,'open')).length,0)
  assert.match(text('#catalog-result'),/30 of 65/)
  nodes.get('#catalog')!.children.find(node=>node.tag==='button')!.click()
  assert.equal(rows().length,60)
  assert.match(text('#catalog-result'),/60 of 65/)
  nodes.get('#model-search')!.value='Exact variant 64'
  runInContext('paintCatalog()',context)
  assert.equal(rows().length,1)
  assert.match(text('#catalog'),/large\/model-64/)
  assert.match(text('#catalog'),/Exact variant 64/)
  assert.match(text('#catalog-result'),/1 of 1/)
  nodes.get('#model-search')!.value=''
  runInContext('paintCatalog()',context)
  assert.equal(rows().length,30)
  assert.equal(requests,0)
})

test("preferred models persist by exact model ID and sort first inside their provider, without touching plans or variants", async () => {
  const localStorage=memoryStorage()
  let requests=0
  const {context,nodes,text}=await dashboardContext({localStorage,fetch:()=>{requests++;throw Error('No network expected')}})
  runInContext(`loadPreferences();show({plans:{review:[{id:'fixture/primary',variant:'Exact High'},'fixture/backup']},agents:{reviewer:'review'},workTypes:{}});renderCatalog({providers:[{id:'fixture',name:'Fixture',models:[{id:'primary',name:'Primary',variants:['Exact High','High fast']},{id:'backup',name:'Backup',variants:[]}]},{id:'other',name:'Other provider',models:[{id:'model',name:'Other',variants:[]}]}]})`,context)
  const original=runInContext('JSON.stringify(editedOptions())',context)
  const planCard=nodes.get('#plans')!.children[0]
  const shell=descendants(nodes.get('#catalog')!).find(node=>node.attributes?.class==='model-shell')!
  const summary=descendants(shell).find(node=>node.tag==='summary')!
  assert.equal(descendants(summary).filter(node=>node.tag==='button').length,0)
  const toggle=descendants(shell).find(node=>node.attributes?.['data-model-preference']==='fixture/primary')!
  assert.equal(toggle.disabled,false)
  toggle.click()
  runInContext(`togglePreferred('other/model')`,context)
  assert.deepEqual(JSON.parse(localStorage.value!).models,['fixture/primary','other/model'])
  const pressed=descendants(nodes.get('#catalog')!).filter(node=>node.attributes?.['data-model-preference']&&node.attributes['aria-pressed']==='true')
  assert.deepEqual(pressed.map(node=>node.attributes!['data-model-preference']),['fixture/primary'])
  assert.match(text('#provider-list'),/★ 2/)
  assert.match(text('#preference-status'),/Saved 2 preferred models in this browser/)
  assert.match(text('#preference-status'),/plan order are unchanged/)
  assert.equal(nodes.get('#plans')!.children[0],planCard)
  assert.equal(runInContext('JSON.stringify(editedOptions())',context),original)
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify(catalogModels()[0].variants)',context)),['Exact High','High fast'])
  const reopened=await dashboardContext({localStorage})
  runInContext('loadPreferences()',reopened.context)
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify([...preferredModels])',reopened.context)),['fixture/primary','other/model'])
  assert.equal(localStorage.writes,2)
  assert.equal(requests,0)
})

test("preferred filtering and suggestions retain missing catalog models without reordering plan chains", async () => {
  const localStorage=memoryStorage(JSON.stringify({version:1,models:['fixture/backup','missing/model','__proto__/constructor']}))
  const {context,nodes,text}=await dashboardContext({localStorage})
  runInContext(`loadPreferences();renderCatalog({providers:[{id:'fixture',name:'Fixture',models:[{id:'primary',name:'Primary',variants:[]},{id:'backup',name:'Backup',variants:['Exact Multiword']},{id:'custom',name:'Custom',variants:[]}]}]})`,context)
  const values=nodes.get('#model-suggestions')!.children.map(node=>node.value)
  assert.deepEqual(values,['fixture/backup','missing/model','__proto__/constructor','fixture/primary','fixture/custom'])
  const first=descendants(nodes.get('#catalog')!).find(node=>node.attributes?.class==='model-shell')!
  assert.match(textOf(first),/fixture\/backup/)
  nodes.get('#preferred-filter')!.checked=true
  runInContext('paintCatalog()',context)
  assert.match(text('#catalog'),/fixture\/backup/)
  assert.doesNotMatch(text('#catalog'),/fixture\/primary/)
  assert.match(text('#catalog-result'),/1 of 1 matching models loaded · 3 in this provider/)
  assert.match(text('#provider-list'),/★ 3/)
  runInContext(`renderCatalog({providers:[{id:'fixture',name:'Fixture',models:[{id:'primary',name:'Primary',variants:[]}]}]})`,context)
  assert.match(text('#catalog'),/No preferred models match this view/)
  assert.deepEqual(JSON.parse(localStorage.value!).models,['fixture/backup','missing/model','__proto__/constructor'])
  assert.equal(localStorage.writes,0)
})

test("malformed or unreadable browser storage fails visibly and is never overwritten", async () => {
  for(const raw of ['not JSON','null','[]','{"version":2,"models":[]}','{"version":1,"models":["no-provider"]}','{"version":1,"models":["fixture/model",false]}']){
    const localStorage=memoryStorage(raw)
    const {context,nodes,text}=await dashboardContext({localStorage})
    runInContext(`loadPreferences();togglePreferred('fixture/model')`,context)
    assert.equal(runInContext('preferenceReady',context),false)
    assert.equal(nodes.get('#preferred-filter')!.disabled,true)
    assert.match(text('#preference-status'),/Could not read the browser shortlist/)
    assert.match(text('#preference-status'),/nothing was overwritten/)
    assert.equal(localStorage.value,raw)
    assert.equal(localStorage.writes,0)
  }
  const {context,text}=await dashboardContext({localStorage:{getItem(){throw Error('Storage blocked')}}})
  runInContext('loadPreferences()',context)
  assert.match(text('#preference-status'),/Storage may be blocked or malformed/)
  runInContext(`Object.defineProperty(globalThis,'localStorage',{get(){throw Error('Access denied')}});loadPreferences()`,context)
  assert.match(text('#plan-preference-status'),/Could not read the browser shortlist/)
})

test("failed or unconfirmed saves retain the last confirmed shortlist, and reload recovers", async () => {
  const original=JSON.stringify({version:1,models:['fixture/known']})
  for(const kind of ['throw','silent','changed-elsewhere']){
    const storage=memoryStorage(original)
    const localStorage={getItem:storage.getItem.bind(storage),setItem(_key:string,_value:string){if(kind==='throw')throw Error('Quota exceeded')}}
    const {context,nodes,text}=await dashboardContext({localStorage})
    runInContext('loadPreferences()',context)
    if(kind==='changed-elsewhere')storage.value=JSON.stringify({version:1,models:['other/external']})
    runInContext(`togglePreferred('fixture/new')`,context)
    assert.deepEqual(JSON.parse(runInContext('JSON.stringify([...preferredModels])',context)),['fixture/known'])
    assert.equal(runInContext('preferenceReady',context),false)
    assert.equal(nodes.get('#preferred-filter')!.disabled,true)
    assert.match(text('#preference-status'),/Could not confirm/)
    assert.doesNotMatch(text('#preference-status'),/^Saved/)
    assert.equal(storage.value,kind==='changed-elsewhere'?JSON.stringify({version:1,models:['other/external']}):original)
    runInContext('loadPreferences()',context)
    assert.equal(runInContext('preferenceReady',context),true)
    assert.match(text('#preference-status'),/Loaded 1 preferred models/)
  }
})

test("preferred toggling is model-level and safe for constructor-style provider and model IDs", async () => {
  const localStorage=memoryStorage(JSON.stringify({version:1,models:['__proto__/constructor','constructor/__proto__']}))
  const {context,nodes}=await dashboardContext({localStorage})
  runInContext(`loadPreferences();renderCatalog({providers:[{id:'__proto__',name:'Special provider',models:[{id:'constructor',name:'Special model',variants:['Exact High','Exact Low']}]}]})`,context)
  const toggle=descendants(nodes.get('#catalog')!).find(node=>node.attributes?.['data-model-preference']==='__proto__/constructor')!
  assert.equal(toggle.attributes?.['aria-pressed'],'true')
  toggle.click()
  assert.deepEqual(JSON.parse(localStorage.value!).models,['constructor/__proto__'])
  assert.equal(runInContext('({}).polluted',context),undefined)
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify(catalogModels()[0].variants)',context)),['Exact High','Exact Low'])
})

test("supply-office ledger uses one theme with decorative section indices and unchanged model references", async () => {
  const page=await readPage('index.html')
  assert.equal((page.match(/<style>/g)||[]).length,1)
  for(const index of ['01','02','03','04']){
    assert.ok(page.includes(`<span class="nav-index" aria-hidden="true">${index}</span>`))
    assert.ok(page.includes(`<span class="register-index" aria-hidden="true">${index}</span>`))
  }
  assert.match(page,/\.content::before\{display:none\}/)
  assert.match(page,/Preferred models only/)
  assert.doesNotMatch(page,/id="preferred-list"/)
  assert.match(page,/prefers-reduced-motion/)
  const {context,nodes,text}=await dashboardContext()
  runInContext(`renderCatalog({providers:[{id:'cursor',name:'Cursor',models:[{id:'grok-4.7',name:'Grok 4.7',variants:['Grok 4.7 High']}]}]})`,context)
  const summary=descendants(nodes.get('#catalog')!).find(node=>node.attributes?.class==='model-entry')!.children[0]
  assert.match(textOf(summary),/Model ID cursor\/grok-4\.7/)
  assert.equal(descendants(summary).filter(node=>node.tag==='button').length,0)
  assert.match(text('#catalog'),/Grok 4\.7 High/)
  assert.equal(runInContext('catalogModels()[0].id',context),'grok-4.7')
})

test("model details preserve ordered price tiers, cache rates, exact zero, and tiny prices", async () => {
  const cost=[
    {input:0,output:0.4,cache:{read:0,write:1e-12}},
    {input:1.25,output:4,cache:{read:0.1,write:0.3},tier:{type:'context',size:128000}},
    {input:9,output:10,cache:{read:2,write:3},tier:{type:'context',size:64000}},
  ]
  const fixture={providers:[{id:'cursor',name:'Cursor',models:[{id:'grok-4.7',name:'Grok 4.7',context:256000,input:200000,output:16000,capabilities:{tools:false,temperature:true,input:['text','image'],output:['text'],secret:'not rendered'},cost,variants:['Grok 4.7 High','High fast']}]}]}
  const {context,nodes,text}=await dashboardContext({fixture:JSON.stringify(fixture)})
  runInContext('renderCatalog(JSON.parse(fixture))',context)
  const pricing=descendants(nodes.get('#catalog')!).find(node=>node.attributes?.class==='catalog-pricing')!
  const schedules=descendants(pricing).filter(node=>node.attributes?.class==='price-schedule')
  assert.equal(schedules.length,3)
  assert.match(textOf(schedules[0]),/Input \$0 Output \$0\.4 Cache read \$0 Cache write \$1e-12/)
  assert.match(textOf(schedules[1]),/^Context tier · 128,000 tokens/)
  assert.match(textOf(schedules[2]),/^Context tier · 64,000 tokens/)
  assert.doesNotMatch(textOf(pricing),/>=|<=|at least|up to|above|below/)
  assert.match(textOf(pricing),/USD per 1M tokens/)
  assert.match(textOf(pricing),/not subscription charges or an account bill/)
  assert.match(textOf(pricing),/variants may have different rates/)
  assert.match(text('#catalog'),/Maximum input 200,000 tokens/)
  assert.match(text('#catalog'),/Input modalities text, image/)
  assert.match(text('#catalog'),/Output modalities text/)
  assert.match(text('#catalog'),/Tools No/)
  assert.match(text('#catalog'),/Temperature control Yes/)
  assert.match(text('#catalog'),/Thinking · high/)
  assert.doesNotMatch(text('#catalog'),/not rendered/)
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify(catalogModels()[0].cost)',context)),cost)
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify(catalogModels()[0].variants)',context)),['Grok 4.7 High','High fast'])
})

test("missing prices and capabilities remain distinct from zero and false; scalar costs are ignored", async () => {
  const fixture={providers:[{id:'fixture',name:'Fixture',models:[
    {id:'unknown',name:'Unknown',cost:{input:0,output:0},variants:[]},
    {id:'partial',name:'Partial',capabilities:{tools:false,temperature:false,input:[],output:['text']},cost:[{input:2e-7,cache:{read:0}}],variants:['Exact Multiword']},
     {id:'invalid',name:'Invalid',input:-1,context:1.5,cost:[{input:-1,output:'0',cache:{read:null,write:-2},tier:{type:'context',size:9007199254740992}},{input:99,output:100,cache:{read:2,write:3},tier:{type:'unsupported',size:5}},null],variants:[]},
  ]}]}
  const {context,nodes}=await dashboardContext({fixture:JSON.stringify(fixture)})
  runInContext('renderCatalog(JSON.parse(fixture))',context)
  const cards=descendants(nodes.get('#catalog')!).filter(node=>node.attributes?.class==='model-shell')
  assert.match(textOf(cards[0]),/Catalog prices not provided/)
  assert.match(textOf(cards[0]),/Tools Not provided/)
  assert.match(textOf(cards[0]),/Temperature control Not provided/)
  assert.match(textOf(cards[0]),/Input modalities Not provided/)
  assert.doesNotMatch(textOf(cards[0]),/\$0|free/i)
  assert.match(textOf(cards[1]),/Input \$2e-7 Output Not provided Cache read \$0 Cache write Not provided/)
  assert.match(textOf(cards[1]),/Input modalities None advertised/)
  assert.match(textOf(cards[1]),/Temperature control No/)
  assert.match(textOf(cards[2]),/Maximum input Unknown/)
   assert.doesNotMatch(textOf(cards[2]),/\$0|\$-1|Context tier/)
   assert.doesNotMatch(textOf(cards[2]),/\$99|\$100|Catalog rate/)
   assert.match(textOf(cards[2]),/Catalog prices not provided/)
})

test("collapsed models expose limit and pricing highlights without disturbing preferred IDs or plan variants", async () => {
  const localStorage=memoryStorage(JSON.stringify({version:1,models:['cursor/grok-4.7']}))
  const models=Array.from({length:7},(_,index)=>({id:index?`model-${index}`:'grok-4.7',name:index?`Model ${index}`:'Grok 4.7',limit:{context:128000,input:120000,output:8192},variants:['Grok 4.7 High'],cost:[{input:1e-8,output:0.5,cache:{read:0,write:1}}]}))
  const {context,nodes}=await dashboardContext({localStorage,fixture:JSON.stringify({providers:[{id:'cursor',name:'Cursor',models}]})})
  runInContext(`loadPreferences();show({plans:{review:[{id:'cursor/grok-4.7',variant:'Grok 4.7 High'}]},agents:{},workTypes:{}})`,context)
  const before=runInContext('JSON.stringify(editedOptions())',context)
  const plan=nodes.get('#plans')!.children[0]
  runInContext('renderCatalog(JSON.parse(fixture))',context)
  const row=descendants(nodes.get('#catalog')!).find(node=>node.attributes?.class==='model-entry')!
  assert.equal(Object.hasOwn(row.attributes!,'open'),false)
  assert.match(textOf(row.children[0]),/Context 128,000 tokens/)
  assert.match(textOf(row.children[0]),/Output 8,192 tokens/)
  assert.match(textOf(row.children[0]),/Catalog \/ 1M: \$1e-8 in · \$0\.5 out/)
  assert.match(textOf(row),/Maximum input 120,000 tokens/)
  assert.equal(runInContext('JSON.stringify(editedOptions())',context),before)
  assert.equal(nodes.get('#plans')!.children[0],plan)
  assert.deepEqual(JSON.parse(localStorage.value!).models,['cursor/grok-4.7'])
  runInContext("togglePreferred('cursor/grok-4.7')",context)
  assert.deepEqual(JSON.parse(localStorage.value!).models,[])
  assert.equal(runInContext('JSON.stringify(editedOptions())',context),before)
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify(catalogModels()[0].variants)',context)),['Grok 4.7 High'])
})

test("small catalogs start collapsed with independently collapsed model detail sections", async () => {
  const fixture={providers:[{id:'cursor',name:'Cursor',models:[{id:'grok-4.7',name:'Grok 4.7',context:128000,output:8192,variants:['Grok 4.7 High'],cost:[{input:0.1,output:0.4,cache:{read:0,write:0.2}}]}]}]}
  const {context,nodes}=await dashboardContext({fixture:JSON.stringify(fixture)})
  runInContext('renderCatalog(JSON.parse(fixture))',context)
  const shell=descendants(nodes.get('#catalog')!).find(node=>node.attributes?.class==='model-shell')!
  const row=shell.children[0]
  assert.equal(row.tag,'details')
  assert.equal(Object.hasOwn(row.attributes!,'open'),false)
  assert.match(textOf(row.children[0]),/Grok 4\.7 Model ID cursor\/grok-4\.7/)
  assert.match(textOf(row.children[0]),/Context 128,000 tokens/)
  assert.match(textOf(row.children[0]),/Catalog \/ 1M: \$0\.1 in · \$0\.4 out/)
  const sections=descendants(row).filter(node=>node.tag==='details'&&node!==row)
   assert.deepEqual(sections.map(node=>node.children[0].textContent),['Token limits','Advertised capabilities','Catalog pricing'])
  for(const section of sections){
    assert.equal(Object.hasOwn(section.attributes!,'open'),false)
    assert.equal(section.children[0].tag,'summary')
    assert.equal(descendants(section.children[0]).filter(node=>node.tag==='button').length,0)
  }
  assert.match(textOf(sections[2]),/Cache read \$0 Cache write \$0\.2/)
   const variants=shell.children[1]
   assert.equal(variants.tag,'section')
   assert.equal(variants.attributes?.['aria-label'],'Possible variants')
   assert.match(textOf(variants),/Possible variants · 1/)
   assert.match(textOf(variants),/Grok 4\.7 High/)
   assert.ok(descendants(shell).find(node=>node.attributes?.['data-model-preference']==='cursor/grok-4.7'))
})

test("explicit model and nested-section expansion survives filters, rerenders, and later closing", async () => {
  const fixture={providers:[{id:'fixture',name:'Fixture',models:[{id:'model',name:'Model',variants:['Exact Multiword']}]}]}
  const {context,nodes}=await dashboardContext({fixture:JSON.stringify(fixture)})
  runInContext('renderCatalog(JSON.parse(fixture))',context)
  const row=()=>descendants(nodes.get('#catalog')!).find(node=>node.attributes?.class==='model-entry')!
  const pricing=()=>descendants(row()).find(node=>node.attributes?.class==='catalog-pricing')!
  row().open=true;row().handlers!.toggle()
  pricing().open=true;pricing().handlers!.toggle()
  runInContext('paintCatalog()',context)
  assert.equal(Object.hasOwn(row().attributes!,'open'),true)
  assert.equal(Object.hasOwn(pricing().attributes!,'open'),true)
  assert.equal(Object.hasOwn(descendants(row()).find(node=>node.children[0]?.textContent==='Token limits')!.attributes!,'open'),false)
  nodes.get('#model-search')!.value='no match'
  runInContext('paintCatalog()',context)
  nodes.get('#model-search')!.value=''
  runInContext('renderCatalog(JSON.parse(fixture))',context)
  assert.equal(Object.hasOwn(row().attributes!,'open'),true)
  assert.equal(Object.hasOwn(pricing().attributes!,'open'),true)
  pricing().open=false;pricing().handlers!.toggle()
  row().open=false;row().handlers!.toggle()
  runInContext('paintCatalog()',context)
  assert.equal(Object.hasOwn(row().attributes!,'open'),false)
  assert.equal(Object.hasOwn(pricing().attributes!,'open'),false)
})

test("provider groups open and close independently across search, preference, refresh, and scope without losing model state", async () => {
  const mk=(id:string,count:number)=>({id,name:id.toUpperCase(),models:Array.from({length:count},(_,i)=>({id:`m${i}`,name:`Model ${i}`,variants:['Exact Multiword']}))})
  const fixture={providers:[mk('alpha',2),mk('beta',2)]}
  const {context,nodes}=await dashboardContext({fixture:JSON.stringify(fixture),localStorage:memoryStorage()})
  runInContext('renderCatalog(JSON.parse(fixture));loadPreferences()',context)
  nodes.get('#provider-filter')!.value=''
  runInContext('paintCatalog()',context)
  const group=(id:string)=>descendants(nodes.get('#catalog')!).find(node=>node.attributes?.class==='model-group'&&textOf(node.children[0]).includes(id.toUpperCase()))!
  const isOpen=(id:string)=>Object.hasOwn(group(id).attributes!,'open')
  assert.equal(isOpen('alpha'),false)
  assert.equal(isOpen('beta'),false)
  assert.match(textOf(group('alpha').children[0]),/2 matching models/)
  const entry=()=>descendants(group('beta')).find(node=>node.attributes?.class==='model-entry')!
  entry().open=true;entry().handlers!.toggle()
  group('beta').open=true;group('beta').handlers!.toggle()
  runInContext('paintCatalog()',context)
  assert.equal(isOpen('alpha'),false)
  assert.equal(isOpen('beta'),true)
  assert.equal(Object.hasOwn(entry().attributes!,'open'),true)
  nodes.get('#model-search')!.value='no match'
  runInContext('paintCatalog()',context)
  nodes.get('#model-search')!.value=''
  runInContext("togglePreferred('beta/m0');renderCatalog(JSON.parse(fixture))",context)
  assert.equal(isOpen('alpha'),false)
  assert.equal(Object.hasOwn(entry().attributes!,'open'),true)
  nodes.get('#provider-filter')!.value='alpha'
  runInContext('paintCatalog()',context)
  assert.equal(isOpen('alpha'),false)
  group('alpha').open=true;group('alpha').handlers!.toggle()
  nodes.get('#provider-filter')!.value=''
  runInContext('paintCatalog()',context)
  assert.equal(isOpen('alpha'),true)
  assert.equal(isOpen('beta'),true)
})

test("show more focuses the visible summary when its provider group is closed", async () => {
  const models=Array.from({length:35},(_,i)=>({id:`m${i}`,name:`Model ${i}`}))
  const fixture={providers:[{id:'alpha',name:'Alpha',models}]}
  const {context,nodes}=await dashboardContext({fixture:JSON.stringify(fixture)})
  const focused:FakeNode[]=[]
  const doc=(context as any).document, create=doc.createElement
  doc.createElement=(tag:string)=>{const n=create(tag) as any;n.focus=()=>focused.push(n);return n}
  runInContext('renderCatalog(JSON.parse(fixture))',context)
  const group=()=>descendants(nodes.get('#catalog')!).find(node=>node.attributes?.class==='model-group')!
  group().open=false;group().handlers!.toggle()
  descendants(nodes.get('#catalog')!).find(node=>node.attributes?.class==='catalog-more')!.click()
  assert.equal(focused.at(-1),group().children[0])
  assert.equal(Object.hasOwn(group().attributes!,'open'),false)
})

test("plans page fetches a writable settings file only from an http gateway", async () => {
  const page = await readPage("index.html")
  assert.match(page, /if\(route==='plans'\|\|route==='providers'\)void maybeLoadPlans\(\)/)
  assert.match(page, /if\(route==='providers'\)void maybeLoadCatalog\(\)/)
  assert.doesNotMatch(page, /\.provider-rail\{display:none\}/)
  assert.doesNotMatch(page, /\.provider-picker\{display:none\}/)
  const providers = page.slice(page.indexOf('data-page="providers"'), page.indexOf('data-page="quota"'))
  assert.ok(providers.indexOf("provider-browser") < providers.indexOf('id="shared-pools"'))
  const plansPanel = page.slice(page.indexOf('id="panel-plans"'), page.indexOf('id="panel-agents"'))
  assert.match(providers, /id="shared-pools"/)
  assert.match(providers, /id="probes"/)
  assert.equal(plansPanel.includes("shared-pools"), false)
  let calls = 0
  const { context, nodes } = await dashboardContext({
    fetch: async (path: string) => {
      calls += 1
      assert.equal(path, "/api/options")
      return { ok: true, json: async () => ({ revision: 4, writable: true, path: "C:/Users/example/.config/opencode/quartermaster.jsonc", options: { plans: { review: ["fixture/model"] }, agents: { reviewer: "review" }, workTypes: {} } }) }
    },
  })
  await runInContext("globalThis.location={protocol:'file:',hash:'#plans'}; maybeLoadPlans()", context)
  assert.equal(calls, 0)
  await runInContext("globalThis.location={protocol:'http:',hash:'#plans'}; maybeLoadPlans()", context)
  assert.equal(calls, 1)
  assert.match(nodes.get("#options-status")!.textContent, /^Loaded the winning settings/)
  assert.equal(nodes.get("#apply-options")!.disabled, false)
  assert.match(textOf(nodes.get("#plans")!), /fixture\/model/)
  await runInContext("maybeLoadPlans()", context)
  assert.equal(calls, 1)
})

test("providers page loads the catalog on an http gateway and lists every provider", async () => {
  let calls = 0
  const { context, nodes } = await dashboardContext({
    fetch: async (path: string) => {
      calls += 1
      assert.equal(path, "/api/providers")
      return { ok: true, json: async () => ({ generatedAt: "2026-10-23T00:00:00.000Z", providers: [
        { id: "alpha", name: "Alpha", models: [{ id: "one", name: "One" }] },
        { id: "beta", name: "Beta", models: [{ id: "two", name: "Two" }] },
      ] }) }
    },
  })
  await runInContext("globalThis.location={protocol:'file:',hash:'#providers'}; maybeLoadCatalog()", context)
  assert.equal(calls, 0)
  await runInContext("globalThis.location={protocol:'http:',hash:'#providers'}; maybeLoadCatalog()", context)
  assert.equal(calls, 1)
  const listed = textOf(nodes.get("#provider-list")!)
  assert.match(listed, /Alpha/)
  assert.match(listed, /Beta/)
  await runInContext("maybeLoadCatalog()", context)
  assert.equal(calls, 1)
})

test("usage page loads quota windows on an http gateway", async () => {
  const page = await readPage("index.html")
  assert.match(page, /if\(route==='quota'\)void maybeLoadWorkspace\(\)/)
  let calls = 0
  const { context, nodes } = await dashboardContext({
    fetch: async (path: string) => {
      calls += 1
      assert.equal(path, "/api/dashboard")
      return { ok: true, json: async () => ({
        apiVersion: 1, projectID: "fixture", generatedAt: "2026-10-23T00:00:00.000Z",
        plans: { review: ["fixture/a"] }, agents: {}, workTypes: {}, report: null,
        availability: { status: "ok", updatedAt: 1780000000000, sources: { openai: {
          sourceID: "codex", stale: false, checkedAt: 1780000000000, availability: "available",
          windows: [{ name: "Weekly", usedPercent: 18, state: "ok", resetsAt: 1780003600000 }],
        } } },
      }) }
    },
  })
  await runInContext("globalThis.location={protocol:'file:',hash:'#quota'}; maybeLoadWorkspace()", context)
  assert.equal(calls, 0)
  await runInContext("globalThis.location={protocol:'http:',hash:'#quota'}; maybeLoadWorkspace()", context)
  assert.equal(calls, 1)
  assert.match(textOf(nodes.get("#quota-providers")!), /Weekly/)
  assert.match(textOf(nodes.get("#quota-providers")!), /18% used/)
  assert.doesNotMatch(textOf(nodes.get("#quota-providers")!), /observed tokens|Unattributed/)
  await runInContext("maybeLoadWorkspace()", context)
  assert.equal(calls, 1)
})
