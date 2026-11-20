import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { createContext, runInContext } from "node:vm"

const readPage = () => readFile(new URL("../web/index.html", import.meta.url), "utf8")
const textOf = (node) => [node.textContent, node.value, ...node.children.map(textOf)].filter(Boolean).join(" ")
const collect = (node, out = []) => { for (const c of node?.children ?? []) { out.push(c); collect(c, out) } return out }

async function routingHarness() {
  const page = await readPage()
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  let fetchCalls = 0
  const nodes = new Map()
  const node = (key) => ({
    key, children: [], textContent: "", value: "", disabled: false, type: "", hidden: false,
    attributes: {}, handlers: {}, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
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
    title: "", visibilityState: "hidden", addEventListener() {}, body: node("body"),
  }
  const context = createContext({
    document: doc,
    fetch: () => { fetchCalls++; return new Promise(() => {}) },
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval() { return 0 }, clearInterval() {},
    location: { protocol: "file:", hash: "" },
    window: { location: { protocol: "file:", hash: "" }, addEventListener() {} },
  })
  runInContext(script, context)
  runInContext(`var fixtureSource=(providerID,windows,over={})=>({providerID,observedAt:Date.now()-60000,stale:false,authenticated:true,windows,...over});
var fixtureEstimate=(cutoffAt)=>({status:'estimated',cutoffPercent:100,ratePerMinute:10,cutoffAt,sampleCount:5,spanMs:30*60000})`, context)
  return {
    page, context, nodes,
    run: (expression) => runInContext(expression, context),
    text: (selector) => textOf(nodes.get(selector)),
    fetchCalls: () => fetchCalls,
  }
}

// Provider ids stay slash-free: modelParts treats the text before the first '/' as the provider.

test("strategy selects expose all six pick-by values and round-trip a choice", async () => {
  const h = await routingHarness()
  const result = JSON.parse(h.run(`(()=>{
    draft={categories:{w:['alpha/m']}}
    const ctrl=slotStrategyControl('probe',()=>'w',()=>{})
    const options=ctrl.node.children.map(option=>option.value+'|'+option.textContent)
    ctrl.node.value='weighted-pace'
    ctrl.node.handlers.change({})
    const weighted=draft.categories.w.pick.by
    ctrl.node.value='window-protection'
    ctrl.node.handlers.change({})
    const protection=draft.categories.w.pick.by
    ctrl.sync()
    return JSON.stringify({options,weighted,protection,shown:ctrl.node.value})
  })()`))
  assert.deepEqual(result.options, [
    "in-order|In order", "reset-soonest|Reset soonest", "pace|Balanced pace",
    "weighted-pace|Weighted pace", "weighted-priority|Weighted by headroom and priority", "window-protection|Window protection",
  ])
  assert.equal(result.weighted, "weighted-pace")
  assert.equal(result.protection, "window-protection")
  assert.equal(result.shown, "window-protection", "sync() reads the saved pick back")
})

test("saved options keep the new pick.by values and reject unknown ones with all six listed", async () => {
  const h = await routingHarness()
  h.run(`draft={plans:{p:['alpha/m']},categories:{w:['alpha/m']}};writeCategoryPick('w','window-protection',[])`)
  const kept = JSON.parse(h.run(`JSON.stringify(editedOptions().categories.w.pick)`))
  assert.deepEqual(kept, { by: "window-protection" }, "the saved config carries window-protection through normalization")
  const both = JSON.parse(h.run(`JSON.stringify(['weighted-pace','weighted-priority','window-protection'].map(by=>normalizeCategories({c:{models:['alpha/m'],pick:{by}}}).c.pick.by))`))
  assert.deepEqual(both, ["weighted-pace", "weighted-priority", "window-protection"])
  const weights = JSON.parse(h.run(`JSON.stringify([{'alpha/m':2},{}].map(weights=>normalizeCategories({c:{models:['alpha/m'],pick:{by:'weighted-priority',weights}}}).c.pick))`))
  assert.deepEqual(weights, [{ by: "weighted-priority", weights: { "alpha/m": 2 } }, { by: "weighted-priority" }])
  let message = ""
  try { h.run(`normalizeCategories({c:{models:['alpha/m'],pick:{by:'weighted'}}})`) } catch (error) { message = error.message }
  assert.match(message, /must be in-order, reset-soonest, pace, weighted-pace, weighted-priority or window-protection/)
})

test("typeahead category suggestions label the two new strategies", async () => {
  const h = await routingHarness()
  h.run(`draft={categories:{alpha:{models:['alpha/m'],pick:{by:'weighted-pace'}},beta:{models:['alpha/m'],pick:{by:'window-protection'}}}}`)
  const wrap = h.run(`(()=>{
    const input=h('input',{type:'text','aria-label':'probe'})
    const wrap=attachModelCombo(input,()=>{})
    input.value='@'
    input.handlers.input({})
    return wrap
  })()`)
  const text = textOf(wrap)
  assert.match(text, /@alpha/, "category appears in suggestions")
  assert.match(text, /1 model · weighted pace/)
  assert.match(text, /1 model · window protection/)
})

test("Routing shows five strategy cards; weighted preview explains shares and never names a winner", async () => {
  const h = await routingHarness()
  h.run(`
    saved={categories:{}}
    usageData=[
      fixtureSource('alpha',[{label:'5h',percent:40,resetsAt:Date.now()+4*3600000,estimate:fixtureEstimate(Date.now()+2*3600000)}]),
      fixtureSource('beta',[{label:'daily',percent:20,resetsAt:Date.now()+20*3600000}]),
    ]
    paintRouting()
  `)
  const text = h.text("#routing-strategies")
  for (const title of ["Reset soonest", "Balanced pace", "Weighted pace", "Window protection", "In order"]) assert.match(text, new RegExp(title))
  assert.match(text, /46%/, "alpha holds sqrt(60) of the softened headroom share")
  assert.match(text, /54%/, "beta holds sqrt(80) of the softened headroom share")
  assert.match(text, /in proportion to the square root of each provider’s remaining headroom/, "weighted card explains the spread")
  assert.match(text, /Headroom %/)
  assert.doesNotMatch(text, /next pick/, "no card pretends to know the weighted winner")
  assert.match(text, /theoretical capacity share, not how traffic actually splits/, "balanced pace copy no longer claims observed allocation")
  assert.doesNotMatch(text, /Share is how the traffic splits/)
  assert.match(text, /×0\.025/, "alpha risk factor = min(1, room 0.25/min ÷ forecast 10/min)")
  assert.match(text, /0\.006/, "alpha adjusted pace = 0.25 × 0.025")
  const order = JSON.parse(h.run(`JSON.stringify(routingStrategyRows().protection.map(row=>row.providerID))`))
  assert.deepEqual(order, ["beta", "alpha"], "window protection ranks by adjusted pace: neutral beta outranks penalized alpha")
})

test("weighted share boosts a provider behind its monthly schedule, and no monthly window changes nothing", async () => {
  const h = await routingHarness()
  h.run(`
    saved={categories:{mix:{models:['alpha/m1','beta/m1'],pick:{by:'weighted-pace'}}}}
    usageData=[
      fixtureSource('alpha',[{label:'5h',percent:40,resetsAt:Date.now()+4*3600000},{label:'monthly',percent:36,resetsAt:Date.now()+140*3600000}]),
      fixtureSource('beta',[{label:'daily',percent:20,resetsAt:Date.now()+20*3600000}]),
    ]
    paintRouting()
  `)
  const text = h.text("#routing-strategies")
  assert.match(text, /Behind monthly %/, "the weighted card names the monthly column")
  // alpha: sqrt(60) × (1 + 22.33/25) vs beta sqrt(80) -> ~62% / ~38%, up from 46/54.
  assert.match(text, /62%/, "the monthly deficit raises alpha's share")
  assert.match(text, /38%/, "beta keeps the remaining share")
  assert.match(text, /22[.,]33/, "the column shows the raw deficit, not the boosted weight")
  assert.match(text, /Headroom %/, "the headroom column stays raw")
  const groups = h.text("#routing-groups")
  assert.match(groups, /62%/, "the category preview mirrors the boosted share")
  assert.match(groups, /38%/)

  // The same providers without a monthly window keep their previous 46/54 split.
  h.run(`
    saved={categories:{}}
    usageData=[
      fixtureSource('alpha',[{label:'5h',percent:40,resetsAt:Date.now()+4*3600000}]),
      fixtureSource('beta',[{label:'daily',percent:20,resetsAt:Date.now()+20*3600000}]),
    ]
    paintRouting()
  `)
  const plain = h.text("#routing-strategies")
  assert.match(plain, /46%/, "no monthly window keeps the unboosted share")
  assert.match(plain, /54%/)
})

test("risk factor gates: usable forecast lowers the factor; missing/invalid keeps neutral ×1; unusable sources have no fresh pace", async () => {
  const h = await routingHarness()
  const clocks = JSON.parse(h.run(`(()=>{
    const now=Date.now()
    const win={label:'5h',percent:40,resetsAt:now+4*3600000}
    const estimated={status:'estimated',cutoffPercent:100,ratePerMinute:2,cutoffAt:now+2*3600000,sampleCount:4,spanMs:1800000}
    const bad=over=>({...estimated,...over})
    return JSON.stringify({
      fresh:providerClock(fixtureSource('p',[{...win,estimate:estimated}])),
      noEstimate:providerClock(fixtureSource('p',[win])),
      flatRate:providerClock(fixtureSource('p',[{...win,estimate:bad({ratePerMinute:0})}])),
      negativeRate:providerClock(fixtureSource('p',[{...win,estimate:bad({ratePerMinute:-5})}])),
      shortSpan:providerClock(fixtureSource('p',[{...win,estimate:bad({spanMs:600000})}])),
      oneSample:providerClock(fixtureSource('p',[{...win,estimate:bad({sampleCount:1})}])),
      staleStatus:providerClock(fixtureSource('p',[{...win,estimate:bad({status:'stale'})}])),
      cutoffOnly:providerClock(fixtureSource('p',[{...win,estimate:bad({ratePerMinute:undefined})}])),
      guessedReset:providerClock(fixtureSource('p',[{...win,resetEstimated:true,estimate:estimated}])),
      highPercent:providerClock(fixtureSource('p',[{...win,percent:150,estimate:estimated}])),
      negativePercent:providerClock(fixtureSource('p',[{...win,percent:-5,estimate:estimated}])),
      unknownAuth:providerClock(fixtureSource('p',[{...win,estimate:estimated}],{authenticated:undefined})),
      errorNormalized:providerClock(usageEntry('p',{stale:false,authenticated:true,observedAt:now-60000,error:'boom',windows:[{...win,estimate:estimated}]})),
      errorNull:providerClock(usageEntry('p',{stale:false,authenticated:true,observedAt:now-60000,error:null,windows:[{...win,estimate:estimated}]})),
      staleSource:providerClock(fixtureSource('p',[{...win,estimate:estimated}],{stale:true})),
      unauthenticated:providerClock(fixtureSource('p',[{...win,estimate:estimated}],{authenticated:false})),
      errorSource:providerClock(fixtureSource('p',[{...win,estimate:estimated}],{error:'boom'})),
      oldClock:providerClock(fixtureSource('p',[{...win,estimate:estimated}],{observedAt:now-10*60000})),
    })
  })()`))
  // JSON.stringify drops undefined keys, so an absent key means undefined on the clock.
  // providerClock re-reads the clock, so numeric comparisons allow a millisecond of drift.
  assert.ok(Math.abs(clocks.fresh.factor - 0.125) < 1e-6, "factor = room per minute / forecast rate")
  assert.ok(Math.abs(clocks.fresh.freshPace.value - 0.25) < 1e-6)
  assert.equal(clocks.fresh.freshHeadroom.value, 60)
  for (const name of ["noEstimate", "flatRate", "negativeRate", "shortSpan", "oneSample", "staleStatus", "cutoffOnly", "guessedReset"]) {
    assert.equal(clocks[name].factor, 1, `${name} keeps the neutral factor 1`)
    assert.ok(Math.abs(clocks[name].freshPace.value - 0.25) < 1e-6, `${name} still has fresh pace`)
  }
  // An error of null is not an error: the source stays usable with its factor computed.
  assert.ok(Math.abs(clocks.errorNull.factor - 0.125) < 1e-6, "error:null is not an error — the forecast still counts")
  for (const name of ["highPercent", "negativePercent"]) {
    assert.ok(!("freshPace" in clocks[name]), `${name} has no fresh pace: percent must sit in 0..100`)
    assert.ok(!("freshHeadroom" in clocks[name]))
    assert.ok("pace" in clocks[name], `${name} keeps its ordinary pace for the balanced card`)
  }
  assert.equal(h.run(`usageEntry('p',{error:'boom'}).error`), "boom", "usageEntry preserves the source's own error")
  assert.equal(h.run(`usageEntry('p',{error:null}).error`), null, "an explicit null error is preserved too")
  for (const name of ["staleSource", "unauthenticated", "errorSource", "errorNormalized", "unknownAuth", "oldClock"]) {
    assert.ok(!("factor" in clocks[name]), `${name} has no factor`)
    assert.ok(!("freshPace" in clocks[name]), `${name} has no fresh pace`)
    assert.ok(!("freshHeadroom" in clocks[name]))
  }
  assert.ok(!("pace" in clocks.staleSource), "a stale source has no pace at all")
  assert.ok("pace" in clocks.oldClock, "an out-of-date clock keeps its ordinary pace for the balanced card")
})

test("worst weekly risk factor is numerical: min over usable forecasts of room-per-minute / rate", async () => {
  const h = await routingHarness()
  const clock = JSON.parse(h.run(`JSON.stringify(providerClock(fixtureSource('weekly',[
    {label:'weekly',percent:50,resetsAt:Date.now()+7*24*3600000,estimate:{status:'estimated',cutoffPercent:100,ratePerMinute:10,cutoffAt:Date.now()+6*24*3600000,sampleCount:4,spanMs:3600000}},
    {label:'daily',percent:90,resetsAt:Date.now()+5*3600000,estimate:{status:'estimated',cutoffPercent:100,ratePerMinute:1,cutoffAt:Date.now()+4*3600000,sampleCount:4,spanMs:3600000}},
  ])))`))
  const weeklyRate = 50 / (7 * 24 * 60)
  assert.ok(Math.abs(clock.freshPace.value - weeklyRate) < 1e-6, "the weekly window is the tightest pace")
  assert.ok(Math.abs(clock.factor - weeklyRate / 10) < 1e-6, "worst factor = weekly room per minute ÷ 10")
  assert.ok(clock.factor < (10 / 300) / 1, "the weekly forecast binds over the daily one")
})

test("window protection card shows risk and adjusted columns, with unknown history honestly unranked", async () => {
  const h = await routingHarness()
  h.run(`
    saved={categories:{}}
    usageData=[
      fixtureSource('neutral',[{label:'5h',percent:40,resetsAt:Date.now()+4*3600000}]),
      fixtureSource('staleprov',[{label:'5h',percent:40,resetsAt:Date.now()+4*3600000}],{stale:true}),
    ]
    paintRouting()
  `)
  const text = h.text("#routing-strategies")
  assert.match(text, /×1/, "neutral keeps the neutral factor in its Risk column")
  assert.match(text, /no fresh pace/, "the stale provider is marked unranked rather than given invented numbers")
  assert.match(text, /stale quota/)
  const order = JSON.parse(h.run(`JSON.stringify(routingStrategyRows().protection.map(row=>row.providerID))`))
  assert.deepEqual(order, ["neutral", "staleprov"], "the stale provider sorts last without a fresh score")
})

test("categories on the new strategies keep their badges, never say next pick, and stay out of the in-order card", async () => {
  const h = await routingHarness()
  h.run(`
    saved={categories:{
      fast:{models:['alpha/m1','beta/m1','alpha/m2'],pick:{by:'weighted-pace'}},
      careful:{models:['alpha/m1'],pick:{by:'window-protection'}},
    }}
    usageData=[
      fixtureSource('alpha',[{label:'5h',percent:40,resetsAt:Date.now()+4*3600000}]),
      fixtureSource('beta',[{label:'daily',percent:20,resetsAt:Date.now()+20*3600000}]),
    ]
    paintRouting()
  `)
  const groups = h.text("#routing-groups")
  assert.match(groups, /@fast/, "weighted category card renders")
  assert.match(groups, /@careful/, "window-protection category card renders")
  assert.match(groups, /drawn winner is the gateway/, "weighted caption hands the pick to the gateway")
  assert.match(groups, /risk factor from usable fresh forecasts/, "protection caption names the factor")
  assert.doesNotMatch(groups, /next pick/)
  assert.ok(groups.indexOf("alpha/m1") < groups.indexOf("beta/m1") && groups.indexOf("beta/m1") < groups.indexOf("alpha/m2"), "weighted preview keeps the declared model order")
  assert.match(groups, /×1/, "window-protection rows show the neutral factor when no forecast exists")
  assert.match(h.text("#routing-strategies"), /No category uses in order/, "neither new strategy counts as in order")
})

test("same-provider model variants do not inflate the weighted share", async () => {
  const h = await routingHarness()
  h.run(`
    saved={categories:{mix:{models:['alpha/m1','beta/m1',{id:'alpha/m2',variant:'v2'}],pick:{by:'weighted-pace'}}}}
    usageData=[
      fixtureSource('alpha',[{label:'5h',percent:40,resetsAt:Date.now()+4*3600000}]),
      fixtureSource('beta',[{label:'daily',percent:20,resetsAt:Date.now()+20*3600000}]),
    ]
    paintRouting()
  `)
  const groups = h.text("#routing-groups")
  assert.equal(groups.split("46%").length - 1, 2, "both alpha rows show the same provider share — the weight is counted once")
  assert.equal(groups.split("54%").length - 1, 1, "beta keeps its share")
  assert.match(groups, /Headroom %/)
  assert.match(groups, /m2 · v2/, "the variant row still renders its variant label")
})

test("weighted priority shares use positional or strongest explicit model weights", async () => {
  const h = await routingHarness()
  h.run(`
    saved={categories:{mix:{models:['alpha/m1','beta/m1','alpha/m2'],pick:{by:'weighted-priority'}}}}
    usageData=['alpha','beta'].map(id=>fixtureSource(id,[{label:'5h',percent:40,resetsAt:Date.now()+4*3600000}]))
    paintRouting()
  `)
  assert.match(h.text("#routing-groups"), /67%/)
  assert.match(h.text("#routing-groups"), /33%/)
  h.run(`saved.categories.mix.pick.weights={'alpha/m2':4};paintRouting()`)
  assert.match(h.text("#routing-groups"), /80%/)
  assert.match(h.text("#routing-groups"), /20%/)
  assert.match(h.text("#routing-strategies"), /No category uses in order/)
})

test("zero-weight providers drop out of the weighted shares without changing the balanced card", async () => {
  const h = await routingHarness()
  h.run(`
    saved={categories:{mix:{models:['full/m1','room/m1'],pick:{by:'weighted-pace'}}}}
    usageData=[
      fixtureSource('full',[{label:'5h',percent:100,resetsAt:Date.now()+4*3600000}]),
      fixtureSource('room',[{label:'5h',percent:40,resetsAt:Date.now()+4*3600000}]),
    ]
    paintRouting()
  `)
  const shareCells = (host) => collect(h.nodes.get(host))
    .filter(n => n.attributes?.class === "num" && /^\d+%$/.test(n.textContent ?? ""))
    .map(n => n.textContent)
  assert.deepEqual(shareCells("#routing-strategies"), ["100%", "0%", "100%"],
    "balanced pace keeps its old share math (room 100%, full 0%); weighted pace drops the zero weight")
  assert.deepEqual(shareCells("#routing-groups"), ["100%"],
    "the category preview also filters the zero weight: full shows — (never matched here), room shows 100%")
})

test("cached availability keeps ordinary pace but gives no fresh pace, forecast or weighted share", async () => {
  const h = await routingHarness()
  const probe = JSON.parse(h.run(`(()=>{
    const now=Date.now()
    const sources={
      alpha:{authenticated:true,stale:false,checkedAt:now-60000,availability:'available',windows:[{label:'5h',usedPercent:40,resetsAt:now+4*3600000}]},
      beta:{authenticated:true,stale:false,checkedAt:now-60000,availability:'available',windows:[{label:'daily',usedPercent:20,resetsAt:now+20*3600000}]},
    }
    const cached=usageFromSources(sources,{status:'ok',cached:true})
    const live=usageFromSources(sources,{status:'ok',cached:false})
    const absent=usageFromSources(sources,{status:'ok'})
    const clock=entry=>{const c=providerClock(entry);return {fresh:c.freshHeadroom!==undefined,freshPace:c.freshPace!==undefined,pace:c.pace!==undefined}}
    return JSON.stringify({
      cachedFlags:cached.map(entry=>entry.cached===true),
      liveFlags:live.map(entry=>'cached' in entry),
      cached:cached.map(clock),live:live.map(clock),absent:absent.map(clock),
    })
  })()`))
  assert.deepEqual(probe.cachedFlags, [true, true], "the cached flag lands on every entry")
  assert.deepEqual(probe.liveFlags, [false, false], "fresh availability carries no flag")
  for (const clock of probe.cached) assert.deepEqual(clock, { fresh: false, freshPace: false, pace: true }, "cached keeps ordinary pace only")
  for (const clock of [...probe.live, ...probe.absent]) assert.deepEqual(clock, { fresh: true, freshPace: true, pace: true })

  h.run(`
    saved={categories:{mix:{models:['alpha/m1','beta/m1'],pick:{by:'weighted-pace'}}}}
    usageData=usageFromSources({
      alpha:{authenticated:true,stale:false,checkedAt:Date.now()-60000,availability:'available',windows:[{label:'5h',usedPercent:40,resetsAt:Date.now()+4*3600000}]},
      beta:{authenticated:true,stale:false,checkedAt:Date.now()-60000,availability:'available',windows:[{label:'daily',usedPercent:20,resetsAt:Date.now()+20*3600000}]},
    },{status:'ok',cached:true})
    paintRouting()
  `)
  const cells = (host) => collect(h.nodes.get(host))
    .filter(n => n.attributes?.class === "num" && /^(\d+%|—)$/.test(n.textContent ?? ""))
    .map(n => n.textContent)
  assert.deepEqual(cells("#routing-groups"), ["—", "—"], "category weighted preview shows no headroom or share for cached sources")
  assert.match(h.text("#routing-groups"), /no fresh headroom/)
  const rows = JSON.parse(h.run(`JSON.stringify({
    fresh:routingStrategyRows().fresh.map(row=>row.clock.freshHeadroom!==undefined),
    pace:routingStrategyRows().pace.map(row=>row.clock.pace!==undefined),
  })`))
  assert.deepEqual(rows.fresh, [false, false], "the weighted card has no fresh headroom to weigh")
  assert.deepEqual(rows.pace, [true, true], "the balanced pace card keeps its ordinary pace")
  assert.match(h.text("#routing-strategies"), /no fresh headroom/)
})

test("weighted-priority preview survives huge finite weights without overflowing the share", async () => {
  const h = await routingHarness()
  h.run(`
    saved={categories:{mix:{models:['alpha/m1','beta/m1'],pick:{by:'weighted-priority',weights:{'alpha/m1':2e306,'beta/m1':2e306}}}}}
    usageData=['alpha','beta'].map(id=>fixtureSource(id,[{label:'5h',percent:40,resetsAt:Date.now()+4*3600000}]))
    paintRouting()
  `)
  const shareCells = (host) => collect(h.nodes.get(host))
    .filter(n => n.attributes?.class === "num" && /^(\d+%|—)$/.test(n.textContent ?? ""))
    .map(n => n.textContent)
  // Each product (60 × 2e306) is finite but their sum overflows; unscaled math would give 0%.
  assert.deepEqual(shareCells("#routing-groups"), ["50%", "50%"], "equal huge weights split evenly, no NaN% or 0%")
  assert.doesNotMatch(h.text("#routing-groups"), /NaN/)
  h.run(`saved.categories.mix.pick.weights={'alpha/m1':2e306,'beta/m1':1e300};paintRouting()`)
  assert.deepEqual(shareCells("#routing-groups"), ["100%", "0%"], "a vastly larger weight takes the share; the other stays numeric")
  h.run(`saved.categories.mix.pick.weights={'alpha/m1':Infinity,'beta/m1':2};paintRouting()`)
  assert.deepEqual(shareCells("#routing-groups"), ["—", "100%"], "an infinite product is dropped, as the router does")
})

test("static wiring: both strategy selects and the page note carry the strategies; no network calls", async () => {
  const page = await readPage()
  assert.equal(page.split("value:'weighted-pace',text:'Weighted pace'").length - 1, 2, "slot control and plan pick select both list it")
  assert.equal(page.split("value:'weighted-priority',text:'Weighted by headroom and priority'").length - 1, 2)
  assert.equal(page.split("value:'window-protection',text:'Window protection'").length - 1, 2)
  assert.match(page, /Weighted pace draws assignments in proportion to the square root of remaining headroom/)
  assert.match(page, /window protection ranks by sustainable pace times a risk factor/i)
  assert.doesNotMatch(page, /Share is how the traffic splits/)
  const h = await routingHarness()
  h.run(`saved={categories:{}};usageData=[];paintRouting()`)
  assert.equal(h.fetchCalls(), 0)
})
