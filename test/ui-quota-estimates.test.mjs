import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { createContext, runInContext } from "node:vm"

const readPage = () => readFile(new URL("../web/index.html", import.meta.url), "utf8")
const textOf = (node) => [node.textContent, node.value, ...node.children.map(textOf)].filter(Boolean).join(" ")

async function renderHarness() {
  const page = await readPage()
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  let calls = 0
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
  const doc = {
    createElement: () => node("fresh-" + Math.random()),    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, node(selector))
      return nodes.get(selector)
    },
    querySelectorAll() { return [] },
    getElementById(id) { return this.querySelector(`#${id}`) },
    title: "",
    visibilityState: "hidden",
    addEventListener() {},
  }
  const context = createContext({
    document: doc,
    fetch: () => { calls++; return new Promise(() => {}) },
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval() { return 0 },
    clearInterval() {},
    location: { hash: "" },
    window: { location: { hash: "" }, addEventListener() {} },
  })
  runInContext(script, context)
  return {
    page, context, nodes,
    render: (data) => runInContext(`renderDashboard(${JSON.stringify(data)})`, context),
    renderProvider: (windows, extra = {}) => runInContext(
      `renderDashboard(${JSON.stringify({
        projectID: "fixture", generatedAt: Date.now(), cooldowns: [],
        availability: { status: "authenticated", sources: { "fixture/prov": { status: "authenticated", observedAt: Date.now(), sourceID: "fixture-source", windows, ...extra } } },
      })})`,
      context,
    ),
    text: (selector) => textOf(nodes.get(selector)),
    eval: (expression) => runInContext(expression, context),
    fetchCalls: () => calls,
  }
}

const estimated = (over = {}) => ({
  status: "estimated",
  cutoffPercent: 100,
  sampleCount: 8,
  spanMs: 47 * 60000,
  ratePerMinute: 1.5,
  cutoffAt: Date.now() + 3600000,
  ...over,
})

test("usage pane keeps windows, bars and reset; Estimates pane carries the forecast", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Daily", percent: 42, resetsAt: Date.now() + 86400000, estimate: estimated() }])
  const usage = h.text("#quota-providers")
  assert.match(usage, /Daily 42% used/)
  assert.match(usage, /Provider reset · /)
  assert.doesNotMatch(usage, /Estimate|cutoff/, "the usage pane never speaks forecast")
  const estimates = h.text("#quota-estimates")
  assert.match(estimates, /Daily 42% used/)
  assert.match(estimates, /Estimate · 100% cutoff ≈ .+ if the recent rate holds \(about 1[.,]5 percentage points\/min over 47 min\)/)
  assert.match(estimates, /estimate basis · 8 samples · 47 min span/)
  assert.doesNotMatch(estimates, /stale quota|out of date|insufficient/)
})

test("reset landing before a future cutoff says so, not a forecast clock", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Daily", percent: 80, resetsAt: Date.now() + 10 * 60000, estimate: estimated({ cutoffAt: Date.now() + 30 * 60000 }) }])
  const text = h.text("#quota-estimates")
  assert.match(text, /reset expected before 100% cutoff at recent usage rate/)
  assert.doesNotMatch(text, /cutoff ≈/)
})

test("estimated window whose cutoff time already passed and is unproven reads out of date, alone", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Daily", percent: 40, estimate: estimated({ cutoffAt: Date.now() - 60000 }) }])
  const text = h.text("#quota-estimates")
  assert.match(text, /Estimate out of date/)
  assert.doesNotMatch(text, /recent rate|cutoff reached|stale quota/)
})

test("estimated window with a passed cutoff but proven observed percent reads cutoff reached (payload-derived percent)", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Daily", percent: 95, estimate: estimated({ cutoffPercent: 90, cutoffAt: Date.now() - 60000 }) }])
  const text = h.text("#quota-estimates")
  assert.match(text, /Routing cutoff reached \(90%\)/)
})

test("reported reset already passed: the estimate reads out of date until a fresh read, never reset-before-cutoff", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Daily", percent: 50, resetsAt: Date.now() - 60000, estimate: estimated() }])
  const text = h.text("#quota-estimates")
  assert.match(text, /Provider reset reported for/)
  assert.match(text, /Estimate out of date/)
  assert.doesNotMatch(text, /reset expected before/)
})

test("stale source suppresses a cutoff-reached estimate: stale quota, not cutoff reached", async () => {
  const h = await renderHarness()
  h.renderProvider(
    [{ label: "Daily", percent: 95, estimate: { status: "cutoff-reached", cutoffPercent: 100, sampleCount: 8, spanMs: 47 * 60000 } }],
    { stale: true },
  )
  const text = h.text("#quota-estimates")
  assert.match(text, /Estimate unavailable · stale quota/)
  assert.doesNotMatch(text, /Routing cutoff reached/)
})

test("future observation timestamp: cutoff-reached reads stale quota", async () => {
  const h = await renderHarness()
  h.renderProvider(
    [{ label: "Daily", percent: 95, estimate: { status: "cutoff-reached", cutoffPercent: 100, sampleCount: 8, spanMs: 47 * 60000 } }],
    { observedAt: Date.now() + 10 * 60000 },
  )
  const text = h.text("#quota-estimates")
  assert.match(text, /Estimate unavailable · stale quota/)
  assert.doesNotMatch(text, /Routing cutoff reached/)
})

test("cutoff-reached with no observation timestamp is stale quota (fail closed)", async () => {
  const h = await renderHarness()
  h.renderProvider(
    [{ label: "Daily", percent: 95, estimate: { status: "cutoff-reached", cutoffPercent: 100, sampleCount: 8, spanMs: 47 * 60000 } }],
    { observedAt: undefined },
  )
  const text = h.text("#quota-estimates")
  assert.match(text, /Estimate unavailable · stale quota/)
})

test("cutoff-reached older than five minutes reads stale quota", async () => {
  const h = await renderHarness()
  h.renderProvider(
    [{ label: "Daily", percent: 95, estimate: { status: "cutoff-reached", cutoffPercent: 100, sampleCount: 8, spanMs: 47 * 60000 } }],
    { observedAt: Date.now() - 6 * 60000 },
  )
  const text = h.text("#quota-estimates")
  assert.match(text, /Estimate unavailable · stale quota/)
})

test("unauthenticated source suppresses the estimate", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Daily", percent: 42, estimate: estimated() }], { authenticated: false })
  const text = h.text("#quota-estimates")
  assert.match(text, /Estimate unavailable · stale quota/)
  assert.doesNotMatch(text, /cutoff ≈/)
})

test("cutoff-reached contradicted by observed percent on a fresh source reads out of date", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Daily", percent: 40, estimate: { status: "cutoff-reached", cutoffPercent: 100, sampleCount: 8, spanMs: 47 * 60000 } }])
  const text = h.text("#quota-estimates")
  assert.match(text, /Estimate out of date/)
})

test("fresh numeric window carries no estimate: insufficient history is reported", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Daily", percent: 10 }])
  const text = h.text("#quota-estimates")
  assert.match(text, /Estimate · insufficient history \(needs at least 15 min of fresh observations\)/)
})

test("unfresh numeric window carries no estimate: stale quota, not insufficient history", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Daily", percent: 10 }], { observedAt: Date.now() - 6 * 60000 })
  const text = h.text("#quota-estimates")
  assert.match(text, /Estimate unavailable · stale quota/)
})

test("no-recent-usage wording on a fresh numeric window", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Daily", percent: 20, estimate: { status: "no-recent-usage", cutoffPercent: 100, sampleCount: 6, spanMs: 60 * 60000 } }])
  assert.match(h.text("#quota-estimates"), /No recent quota increase; estimate unavailable/)
})

test("stale-status estimate wording on a fresh source still reports stale quota", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Daily", percent: 30, estimate: { status: "stale", cutoffPercent: 100, sampleCount: 4, spanMs: 30 * 60000 } }])
  assert.match(h.text("#quota-estimates"), /Estimate unavailable · stale quota/)
})

test("insufficient-history status wording", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Daily", percent: 10, estimate: { status: "insufficient-history", cutoffPercent: 100, sampleCount: 1, spanMs: 5 * 60000 } }])
  assert.match(h.text("#quota-estimates"), /Estimate · insufficient history \(needs at least 15 min of fresh observations\)/)
})

test("window without a numeric percent omits the estimate entirely, reset still renders", async () => {
  const h = await renderHarness()
  h.renderProvider([
    { label: "Requests", remaining: 120, resetsAt: Date.now() + 3600000 },
    { label: "Daily", percent: Number.NaN, estimate: estimated() },
  ])
  const usage = h.text("#quota-providers")
  assert.match(usage, /Provider reset · /)
  assert.doesNotMatch(usage, /\d+% used/)
  const estimates = h.text("#quota-estimates")
  assert.match(estimates, /No quota estimates yet/)
  assert.doesNotMatch(estimates, /Estimate ·|Routing cutoff|percentage points\/min/)
})

test("a very low rate never rounds to zero", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Daily", percent: 10, estimate: estimated({ ratePerMinute: 0.004, spanMs: 30 * 60000 }) }])
  const text = h.text("#quota-estimates")
  assert.match(text, /rate less than 0\.01 percentage points\/min over 30 min/)
  assert.doesNotMatch(text, /about 0 /)
})

test("normalizer enforces backend bounds, drops the whole malformed estimate, keeps good quota", async () => {
  const h = await renderHarness()
  const windows = JSON.parse(h.eval(`JSON.stringify(usageWindows([
    { label: "Valid", percent: 42, resetsAt: 1000, estimate: ${JSON.stringify(estimated({ cutoffAt: 1000000, spanMs: 16 * 60000, sampleCount: 2 }))} },
    { label: "BadStatus", percent: 42, estimate: { status: "flying", cutoffPercent: 100, sampleCount: 3, spanMs: 900000 } },
    { label: "NoCutoff", percent: 42, estimate: { status: "estimated", sampleCount: 3, spanMs: 900000, ratePerMinute: 1, cutoffAt: 1000 } },
    { label: "NoSample", percent: 42, estimate: { status: "estimated", cutoffPercent: 100, spanMs: 900000, ratePerMinute: 1, cutoffAt: 1000 } },
    { label: "OneSample", percent: 42, estimate: { status: "estimated", cutoffPercent: 100, sampleCount: 1, spanMs: 900000, ratePerMinute: 1, cutoffAt: 1000 } },
    { label: "ShortSpan", percent: 42, estimate: { status: "estimated", cutoffPercent: 100, sampleCount: 3, spanMs: 14 * 60000, ratePerMinute: 1, cutoffAt: 1000 } },
    { label: "NegRate", percent: 42, estimate: { status: "estimated", cutoffPercent: 100, sampleCount: 3, spanMs: 900000, ratePerMinute: -2, cutoffAt: 1000 } },
    { label: "ZeroRate", percent: 42, estimate: { status: "estimated", cutoffPercent: 100, sampleCount: 3, spanMs: 900000, ratePerMinute: 0, cutoffAt: 1000 } },
    { label: "FutureAt", percent: 42, estimate: { status: "estimated", cutoffPercent: 100, sampleCount: 3, spanMs: 900000, ratePerMinute: 1, cutoffAt: -5 } },
    { label: "BigCutoff", percent: 42, estimate: { status: "cutoff-reached", cutoffPercent: 150, sampleCount: 3, spanMs: 900000 } },
    { label: "NoMeta", percent: 42, estimate: { status: "no-recent-usage" } },
    { label: "BadShape", percent: 42, estimate: "soon" },
    { label: "Untouched", percent: 42 },
    { label: "ResetStream", resetsAt: "1970-01-01T00:00:01Z", resetEstimated: true },
  ]))`))
  assert.deepEqual(windows[0], {
    label: "Valid", percent: 42, resetsAt: 1000,
    estimate: { status: "estimated", cutoffPercent: 100, sampleCount: 2, spanMs: 960000, ratePerMinute: 1.5, cutoffAt: 1000000 },
  }, "valid metadata round-trips")
  for (const w of windows.slice(1, 13)) assert.equal(w.estimate, undefined, `${w.label}: non-conforming estimate dropped whole`)
  assert.equal(windows.find(w => w.label === "Untouched").percent, 42, "good quota survives malformed neighbors")
  assert.equal(windows.find(w => w.label === "ResetStream").resetsAt, 1000, "string reset timestamps still parse")
  assert.equal(windows.find(w => w.label === "ResetStream").resetEstimated, true)
})

test("quota page gains an Estimates tab: default Usage, aria-linked panels, click and keyboard selection", async () => {
  const page = await readPage()
  assert.equal((page.match(/id="quota-tab-/g) || []).length, 2, "exactly two quota tabs, unique ids")
  assert.match(page, /id="quota-tab-usage" aria-selected="true" aria-controls="quota-panel-usage" tabindex="0"/)
  assert.match(page, /id="quota-tab-estimates" aria-selected="false" aria-controls="quota-panel-estimates" tabindex="-1"/)
  assert.match(page, /id="quota-panel-usage" role="tabpanel" aria-labelledby="quota-tab-usage" tabindex="0"/)
  assert.match(page, /id="quota-panel-estimates" role="tabpanel" aria-labelledby="quota-tab-estimates" tabindex="-1" hidden/)
  const h = await renderHarness()
  const usageTab = h.nodes.get("#quota-tab-usage"), estimatesTab = h.nodes.get("#quota-tab-estimates")
  assert.ok(usageTab && estimatesTab, "both tabs wired at init")
  assert.ok(typeof usageTab.handlers.click === "function" && typeof estimatesTab.handlers.click === "function")
  runInContext('selectQuotaView("usage")', h.context)
  assert.equal(h.nodes.get("#quota-panel-estimates")?.hidden, true, "Estimates panel starts hidden")
  assert.equal(h.nodes.get("#quota-panel-usage")?.hidden, false, "Usage panel starts shown")
  assert.equal(usageTab.tabIndex, 0, "active tab is in the roving tabindex")
  assert.equal(estimatesTab.tabIndex, -1)
  assert.equal(h.nodes.get("#quota-panel-usage")?.tabIndex, 0, "active panel joins the roving tabindex")
  assert.equal(h.nodes.get("#quota-panel-estimates")?.tabIndex, -1)
  estimatesTab.handlers.click()
  assert.equal(estimatesTab.attributes["aria-selected"], "true")
  assert.equal(usageTab.attributes["aria-selected"], "false")
  assert.equal(h.nodes.get("#quota-panel-estimates")?.hidden, false)
  assert.equal(h.nodes.get("#quota-panel-usage")?.hidden, true)
  assert.equal(estimatesTab.tabIndex, 0, "roving tabindex follows the click")
  assert.equal(usageTab.tabIndex, -1)
  assert.equal(h.nodes.get("#quota-panel-estimates")?.tabIndex, 0)
  assert.equal(h.nodes.get("#quota-panel-usage")?.tabIndex, -1)
  assert.ok(typeof estimatesTab.handlers.keydown === "function", "keyboard support like the plans tabs")
  estimatesTab.handlers.keydown({ key: "ArrowLeft", preventDefault() {} })
  assert.equal(usageTab.attributes["aria-selected"], "true")
  assert.equal(estimatesTab.attributes["aria-selected"], "false")
  assert.equal(h.nodes.get("#quota-panel-usage")?.hidden, false)
  assert.equal(usageTab.tabIndex, 0, "roving tabindex follows the keyboard")
  assert.equal(estimatesTab.tabIndex, -1)
  runInContext('selectQuotaView("usage")', h.context)
})

test("estimates pane data: provider card, basis, reported reset and observation freshness; empty state without numeric windows", async () => {
  const h = await renderHarness()
  h.renderProvider([])
  assert.match(h.text("#quota-estimates"), /No quota estimates yet\.?/)
  h.renderProvider([{ label: "Daily", percent: 42, resetsAt: Date.now() + 86400000, estimate: estimated() }])
  const text = h.text("#quota-estimates")
  assert.match(text, /fixture\/prov/, "provider card names the source")
  assert.match(text, /Daily 42% used/)
  assert.match(text, /Estimate · 100% cutoff ≈ /)
  assert.match(text, /estimate basis · 8 samples · 47 min span/)
  assert.match(text, /Provider reset reported for/)
  assert.match(text, /Quota observed .+ fresh observation/)
})

test("forecast stays off the Usage pane and the Overview stats even when estimates exist", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Daily", percent: 42, estimate: estimated() }])
  const usage = h.text("#quota-providers")
  assert.doesNotMatch(usage, /Estimate ·|cutoff ≈|percentage points\/min/)
  for (const selector of ["#overview-stats", "#overview-chart", "#overview-attention"]) {
    const node = h.nodes.get(selector)
    if (node) assert.doesNotMatch(textOf(node), /Estimate ·|cutoff ≈|percentage points\/min/, `${selector} stays forecast-free`)
  }
})

test("routing annotations use the 100% gate: 95 is not limited, 100 is 'quota fully used'", async () => {
  const h = await renderHarness()
  const window = percent => ({ label: "Daily", percent, resetsAt: Date.now() + 3600000 })
  h.render({
    projectID: "fixture", generatedAt: Date.now(), cooldowns: [],
    availability: {
      status: "authenticated",
      sources: {
        "fixture/low": { status: "authenticated", observedAt: Date.now(), windows: [window(95)] },
        "fixture/full": { status: "authenticated", observedAt: Date.now(), windows: [window(100)] },
      },
    },
  })
  runInContext("paintRouting()", h.context)
  const screen = h.text("#routing-strategies") + " " + h.text("#routing-groups")
  assert.doesNotMatch(screen, /over the 90% gate/, "the removed 90% note is gone everywhere")
  assert.match(screen, /95% used/, "the 95% provider renders")
  assert.doesNotMatch(screen, /95% used · quota fully used/, "95% is not marked limited")
  assert.match(screen, /100% used · quota fully used/, "only 100% is marked fully used")
})

test("tab strip carries the plain-language estimate disclaimer on the Estimates panel", async () => {
  const page = await readPage()
  const panel = page.slice(page.indexOf('id="quota-panel-estimates"'), page.indexOf('id="quota-estimates"'))
  assert.match(panel, /informational only/)
  assert.match(panel, /until 100%/)
  assert.match(panel, /not a guarantee that all remaining quota is usable/)
  assert.match(panel, /bypasses a reported limit/)
  assert.match(panel, /never guessed/)
  assert.match(panel, /at least 15 minutes of fresh authenticated history/)
  assert.match(panel, /no numeric quota percent/)
  assert.match(panel, /About API values/)
  assert.match(panel, /must not be summed/)
  assert.match(panel, /retained for 90 days/)
  assert.match(panel, /never that history/)
  assert.match(panel, /known subtotal but blocks the full-allowance projection/)
  assert.doesNotMatch(panel, /comes from older cumulative data|stays undercounted|90% mark|90% gate/)
})

const apiValue = (over = {}) => ({
  currency: "USD",
  basis: "api-equivalent-not-billed",
  complete: false,
  projectionStatus: "estimated",
  observedUSD: 12.34,
  projectedFullUSD: 45.6,
  reason: null,
  trackingSince: Date.now() - 47 * 60000,
  observedAt: Date.now(),
  spanMs: 47 * 60000,
  quotaDeltaPercent: 12,
  records: 10,
  pricedRecords: 10,
  unpricedRecords: 0,
  partialRecords: 0,
  ...over,
})

test("valid apiValue: observed cash with priced/track-span qualifiers and the full-allowance projection", async () => {
  const h = await renderHarness()
  const T = Date.now()
  h.renderProvider([{ label: "Daily", percent: 42, estimate: estimated(), apiValue: apiValue({ observedAt: T, trackingSince: T - 47 * 60000 }) }], { observedAt: T })
  const text = h.text("#quota-estimates")
  assert.match(text, /Observed API value ≈ USD 12[.,]34/)
  assert.match(text, /10 of 10 records priced/)
  assert.doesNotMatch(text, /partial/)
  assert.match(text, /47 min track span/)
  assert.match(text, /Estimated full allowance ≈ USD 45[.,]6 · approximate; recent USD per percentage point, not a provider budget/)
  assert.doesNotMatch(text, /complete[=:] ?true/i)
})

test("explicit zero observed pricing and a zero full-allowance projection are both valid, never unpriced", async () => {
  const h = await renderHarness()
  const T = Date.now()
  h.renderProvider([{ label: "Daily", percent: 42, apiValue: apiValue({ observedUSD: 0, projectedFullUSD: null, projectionStatus: "unavailable", reason: "Need 15 minutes", observedAt: T, trackingSince: T - 47 * 60000 }) }], { observedAt: T })
  const text = h.text("#quota-estimates")
  assert.match(text, /Observed API value ≈ USD 0 · zero priced work so far/)
  assert.match(text, /Estimated full allowance unavailable — Need 15 minutes/)
  const g = await renderHarness()
  const U = Date.now()
  g.renderProvider([{ label: "Daily", percent: 42, apiValue: apiValue({ observedUSD: 0, projectedFullUSD: 0, observedAt: U, trackingSince: U - 47 * 60000 }) }], { observedAt: U })
  assert.match(g.text("#quota-estimates"), /Estimated full allowance ≈ USD 0 · approximate/)
  assert.doesNotMatch(g.text("#quota-estimates"), /unpriced/)
})

test("unpriced window shows unpriced wording, never a fabricated 0 or projection", async () => {
  const h = await renderHarness()
  const T = Date.now()
  h.renderProvider([{ label: "Daily", percent: 42, apiValue: apiValue({ observedUSD: null, pricedRecords: 0, unpricedRecords: 10, projectedFullUSD: null, projectionStatus: "unavailable", reason: "API prices unavailable", observedAt: T, trackingSince: T - 47 * 60000 }) }], { observedAt: T })
  const text = h.text("#quota-estimates")
  assert.match(text, /Observed API value · unpriced \(no priced work recorded yet\)/)
  assert.match(text, /Estimated full allowance unavailable — API prices unavailable/)
})

test("window without apiValue (older host) says not tracked, waiting — not zero", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Daily", percent: 42 }])
  const text = h.text("#quota-estimates")
  assert.match(text, /Observed API value · not tracked yet/)
  assert.doesNotMatch(text, /Estimated full allowance|USD 0/)
})

test("stale and unauthenticated sources hide current API values and projections", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Daily", percent: 42, apiValue: apiValue() }], { stale: true })
  assert.match(h.text("#quota-estimates"), /Observed API value unavailable · stale quota/)
  const g = await renderHarness()
  g.renderProvider([{ label: "Daily", percent: 42, apiValue: apiValue() }], { authenticated: false })
  assert.match(g.text("#quota-estimates"), /Observed API value unavailable · stale quota/)
  assert.doesNotMatch(g.text("#quota-estimates"), /≈ USD/)
})

test("apiValue rejections per contract: drops whole block, keeps window quota and whitelist keys", async () => {
  const h = await renderHarness()
  const cases = [
    { label: "Currency", apiValue: apiValue({ currency: "EUR" }) },
    { label: "Basis", apiValue: apiValue({ basis: "retail" }) },
    { label: "Complete", apiValue: apiValue({ complete: true }) },
    { label: "Status", apiValue: apiValue({ projectionStatus: "flying" }) },
    { label: "Fractional", apiValue: apiValue({ pricedRecords: 6.5 }) },
    { label: "CounterSum", apiValue: apiValue({ unpricedRecords: 5 }) },
    { label: "PartialOverflow", apiValue: apiValue({ partialRecords: 11 }) },
    { label: "EstimatedDeltaZero", apiValue: apiValue({ quotaDeltaPercent: 0 }) },
    { label: "EstimatedShortSpan", apiValue: apiValue({ spanMs: 14 * 60000, trackingSince: Date.now() - 14 * 60000 }) },
    { label: "SpanMismatch", apiValue: apiValue({ observedAt: Date.now() - 48 * 60000, trackingSince: Date.now() - 47 * 60000 }) },
    { label: "TrackNullSpan", apiValue: apiValue({ trackingSince: null }) },
    { label: "NoRecords", apiValue: apiValue({ records: undefined }) },
    { label: "NoClock", apiValue: apiValue({ observedAt: undefined }) },
    { label: "NegCash", apiValue: apiValue({ observedUSD: -5 }) },
    { label: "NoCashWithPrices", apiValue: apiValue({ observedUSD: null }) },
    { label: "EstimatedReason", apiValue: apiValue({ reason: "working on it" }) },
    { label: "NoProjection", apiValue: apiValue({ projectedFullUSD: null }) },
    { label: "ReasonGone", apiValue: apiValue({ projectionStatus: "unavailable", projectedFullUSD: null, reason: "" }) },
    { label: "MissingDelta", apiValue: apiValue({ projectionStatus: "unavailable", projectedFullUSD: null, reason: "ok", quotaDeltaPercent: undefined }) },
    { label: "ReasonControl", apiValue: apiValue({ projectionStatus: "unavailable", projectedFullUSD: null, reason: "line\nbreak" }) },
    { label: "ReasonLong", apiValue: apiValue({ projectionStatus: "unavailable", projectedFullUSD: null, reason: "x".repeat(161) }) },
  ]
  const windows = JSON.parse(h.eval(`JSON.stringify(usageWindows(${JSON.stringify(cases.map(item => ({ percent: 42, label: item.label, apiValue: item.apiValue })))}))`))
  for (const w of windows) assert.equal(w.apiValue, undefined, `${w.label}: contract violation rejected whole`)
  assert.equal(windows[0].percent, 42, "good quota fields survive every rejection")
  const kept = JSON.parse(h.eval(`JSON.stringify(usageWindows([{ percent: 42, apiValue: ${JSON.stringify(apiValue({ junkUSD: 999, totalUSD: "many" }))} }]))`))[0].apiValue
  assert.deepEqual(new Set(Object.keys(kept)), new Set(["currency", "basis", "complete", "projectionStatus", "trackingSince", "observedAt", "spanMs", "observedUSD", "projectedFullUSD", "quotaDeltaPercent", "reason", "records", "pricedRecords", "unpricedRecords", "partialRecords"]), "whitelisted keys only")
  assert.equal(kept.complete, false, "normalized payload carries the backend complete:false literal")
  assert.equal(kept.observedUSD, 12.34)
  assert.equal(kept.projectedFullUSD, 45.6)
  h.renderProvider([{ label: "Bad", percent: 42, apiValue: apiValue({ currency: "EUR" }) }, { label: "Good", percent: 42, apiValue: apiValue() }])
  const render = h.text("#quota-estimates")
  assert.match(render, /not tracked yet/)
  assert.match(render, /Observed API value ≈ USD 12[.,]34/, "a valid block beside a rejected one still renders")
  assert.doesNotMatch(render, /999|many/)
})

test("a dollar value clock mismatched by even one minute — older or future — is not presented as current", async () => {
  const h = await renderHarness()
  const T = Date.now()
  h.renderProvider([{
    label: "Daily", percent: 42,
    apiValue: apiValue({ observedAt: T - 60000, trackingSince: T - 60000 - 47 * 60000 }),
  }], { observedAt: T })
  const text = h.text("#quota-estimates")
  assert.match(text, /Observed API value unavailable · stale value observation/, "one minute behind fails exact equality")
  assert.doesNotMatch(text, /≈ USD/)
  assert.doesNotMatch(text, /Estimated full allowance ≈/)
  const g = await renderHarness()
  const F = Date.now()
  g.renderProvider([{
    label: "Daily", percent: 42,
    apiValue: apiValue({ observedAt: F + 60000, trackingSince: F + 60000 - 47 * 60000 }),
  }], { observedAt: F })
  const gtext = g.text("#quota-estimates")
  assert.match(gtext, /Observed API value unavailable · stale value observation/, "future unequal clock also suppressed")
  assert.doesNotMatch(gtext, /≈ USD/)
})

test("providers without numeric quota windows render no API values and the tab makes no network calls", async () => {
  const h = await renderHarness()
  h.renderProvider([{ label: "Requests", remaining: 5, apiValue: apiValue() }])
  assert.match(h.text("#quota-estimates"), /No quota estimates yet/)
  const T = Date.now()
  h.renderProvider([{ label: "Daily", percent: 42, apiValue: apiValue({ observedAt: T, trackingSince: T - 47 * 60000 }) }, { label: "Weekly", percent: 10, apiValue: apiValue({ observedUSD: 3, observedAt: T, trackingSince: T - 47 * 60000 }) }], { observedAt: T })
  assert.match(h.text("#quota-estimates"), /Observed API value ≈ USD 3 · 10 of 10 records priced/)
  assert.equal(h.fetchCalls(), 0, "rendering stays off the wire")
})

test("quota page spacing: tabs to tiles 24px, and the green notes get the page's 26px top margin", async () => {
  const page = await readPage()
  const style = page.slice(page.indexOf("<style>"), page.indexOf("</style>"))
  assert.match(style, /#quota-providers,#quota-estimates\{margin-top:24px\}/)
  assert.match(style, /#quota-panel-estimates \.note\{margin-top:26px\}/)
  // the rule lives after .tab-panel so it wins by source order, and touches no other page
  assert.ok(style.indexOf(".tab-panel{min-width:0}") < style.indexOf("#quota-providers,#quota-estimates{margin-top:24px}"))
  assert.doesNotMatch(style, /\busage-grid\{[^}]*margin-top/)
})
