import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { parseConfig } from "../src/config.ts"

test("example config parses", async () => {
  const input = JSON.parse(await readFile(new URL("../examples/quartermaster.json", import.meta.url), "utf8"))
  assert.equal(parseConfig(input).plans.review.length, 4)
})

test("normalizes candidates, variants, bindings, and defaults", () => {
  const config = parseConfig({
    plans: { review: ["provider-a/quality", { id: "provider-b/backup", variant: "fast" }] },
    agents: { reviewer: "review" },
    workTypes: { audit: "review" },
    usageSources: { "provider-a": "codex" },
    quotaExemptModels: ["provider-a/free-model"],
    localEndpoints: { ollama: "http://127.0.0.1:11434" },
  })
  assert.deepEqual(config.plans.review, [
    { providerID: "provider-a", modelID: "quality" },
    { providerID: "provider-b", modelID: "backup", variant: "fast" },
  ])
  assert.deepEqual(config.agents, { reviewer: "review" })
  assert.deepEqual(config.workTypes, { audit: "review" })
  assert.deepEqual(config.usageSources, { "provider-a": "codex" })
  assert.deepEqual(config.quotaExemptModels, ["provider-a/free-model"])
  assert.equal(config.providerCooldownMs, 300_000)
  assert.equal(config.localHealthTimeoutMs, 2_000)
  assert.deepEqual(config.localEndpoints, { ollama: "http://127.0.0.1:11434/" })
})

test("parses opt-in token budgets without enabling them by default", () => {
  assert.equal(parseConfig({}).budgets, undefined)
  assert.deepEqual(parseConfig({ budgets: [
    { id: "project-month", dimension: "project", mode: "advisory", limitTokens: 1_000_000, windowMs: 30 * 86_400_000 },
    { id: "provider-day", dimension: "provider", mode: "advisory", target: "provider-a", limitTokens: 20_000, windowMs: 86_400_000 },
    { id: "model-day", dimension: "model", mode: "advisory", target: "provider-a/model-a", limitTokens: 10_000, windowMs: 86_400_000 },
    { id: "plugin-day", dimension: "plugin", mode: "advisory", target: "consumer", limitTokens: 5_000, windowMs: 86_400_000 },
  ] }).budgets, [
    { id: "project-month", dimension: "project", mode: "advisory", limitTokens: 1_000_000, windowMs: 30 * 86_400_000 },
    { id: "provider-day", dimension: "provider", mode: "advisory", target: "provider-a", limitTokens: 20_000, windowMs: 86_400_000 },
    { id: "model-day", dimension: "model", mode: "advisory", target: "provider-a/model-a", limitTokens: 10_000, windowMs: 86_400_000 },
    { id: "plugin-day", dimension: "plugin", mode: "advisory", target: "consumer", limitTokens: 5_000, windowMs: 86_400_000 },
  ])
})

test("validates optional token cost rates and exact model variants", () => {
  const rate = { providerID: "provider-a", modelID: "model-a", variant: "fast", inputPerMillion: 0.5, outputPerMillion: 1.25, currency: "USD", source: "provider rate page", asOf: 1_700_000_000_000 }
  assert.deepEqual(parseConfig({ tokenRates: [rate] }).tokenRates, [rate])
  for (const rates of [
    [{ ...rate, inputPerMillion: -1 }],
    [{ ...rate, outputPerMillion: Number.POSITIVE_INFINITY }],
    [{ ...rate, currency: "usd" }],
    [{ ...rate, asOf: 1.5 }],
    [{ ...rate, extra: true }],
    [rate, rate],
  ]) assert.throws(() => parseConfig({ tokenRates: rates }), /tokenRates/)
  assert.throws(() => parseConfig({ tokenRates: Array.from({ length: 101 }, (_, i) => ({ ...rate, modelID: `model-${i}` })) }), /at most 100/)
})

test("rejects invalid budget dimensions, targets, windows, limits, and duplicate IDs", () => {
  const budget = { id: "day", dimension: "project", limitTokens: 10, windowMs: 1_000 }
  assert.throws(() => parseConfig({ budgets: [{ ...budget, dimension: "session" }] }), /budgets\[0\]\.dimension/)
  assert.throws(() => parseConfig({ budgets: [{ ...budget, target: "project-a" }] }), /project budgets do not accept a target/)
  assert.throws(() => parseConfig({ budgets: [{ ...budget, limitTokens: 0 }] }), /limitTokens: expected a positive safe integer/)
  assert.throws(() => parseConfig({ budgets: [{ ...budget, windowMs: 1.5 }] }), /windowMs: expected a positive safe integer/)
  assert.throws(() => parseConfig({ budgets: [{ ...budget, id: "day" }, { ...budget, id: "day" }] }), /duplicate budget ID/)
  assert.throws(() => parseConfig({ budgets: [{ ...budget, dimension: "model", target: "unqualified" }] }), /target: expected providerID\/modelID/)
  assert.throws(() => parseConfig({ budgets: [{ ...budget, mode: "enforce" }] }), /mode: expected advisory or strict/)
})

test("normalizes calendar budget windows and rejects invalid window definitions", () => {
  assert.deepEqual(parseConfig({ budgets: [{
    id: "calendar-day", dimension: "project", mode: "advisory", limitTokens: 10,
    calendarWindow: { unit: "day" },
  }] }).budgets, [{
    id: "calendar-day", dimension: "project", mode: "advisory", limitTokens: 10,
    calendarWindow: { unit: "day", timeZone: "UTC" },
  }])
  assert.throws(() => parseConfig({ budgets: [{
    id: "bad-unit", dimension: "project", limitTokens: 10,
    calendarWindow: { unit: "year" },
  }] }), /calendarWindow\.unit/)
  assert.throws(() => parseConfig({ budgets: [{
    id: "bad-zone", dimension: "project", limitTokens: 10,
    calendarWindow: { unit: "day", timeZone: "Mars\/Phobos" },
  }] }), /calendarWindow\.timeZone/)
  assert.throws(() => parseConfig({ budgets: [{
    id: "both", dimension: "project", limitTokens: 10, windowMs: 1000,
    calendarWindow: { unit: "day" },
  }] }), /exactly one/)
  assert.throws(() => parseConfig({ budgets: [{
    id: "neither", dimension: "project", limitTokens: 10,
  }] }), /exactly one/)
})

test("preserves slashes inside provider model IDs", () => {
  assert.deepEqual(parseConfig({ plans: { review: ["openrouter/vendor/model"] } }).plans.review[0], {
    providerID: "openrouter",
    modelID: "vendor/model",
  })
})

test("allows no bindings and accepts custom durations", () => {
  assert.deepEqual(parseConfig({}), {
    plans: {}, agents: {}, workTypes: {}, usageSources: {}, quotaExemptModels: [], exclusiveModels: [], sharedRateLimits: [],
    providerCooldownMs: 300_000, localHealthTimeoutMs: 2_000, localEndpoints: {},
  })
  assert.equal(parseConfig({ providerCooldownMs: 30, localHealthTimeoutMs: 50 }).providerCooldownMs, 30)
})

test("normalizes ordered module models with entry, module, and provider cooldowns", () => {
  const config = parseConfig({
    providerCooldownMs: 60_000,
    modules: {
      "opr-jev": {
        cooldownMs: 120_000,
        models: [{ id: "opencode/jev-1.13-free", cooldownMs: 900_000 }, "opencode/jev-1.13"],
      },
      generic: { models: [{ id: "openrouter/vendor/model", variant: "fast" }, "other/backup"] },
    },
  })
  assert.deepEqual(config.modules, {
    "opr-jev": {
      cooldownMs: 120_000,
      models: [
        { providerID: "opencode", modelID: "jev-1.13-free", cooldownMs: 900_000 },
        { providerID: "opencode", modelID: "jev-1.13", cooldownMs: 120_000 },
      ],
    },
    generic: {
      cooldownMs: 60_000,
      models: [
        { providerID: "openrouter", modelID: "vendor/model", variant: "fast", cooldownMs: 60_000 },
        { providerID: "other", modelID: "backup", cooldownMs: 60_000 },
      ],
    },
  })
  const { modules, ...native } = config
  assert.deepEqual(native, parseConfig({ providerCooldownMs: 60_000 }), "module models create no native plans, bindings, or exemptions")
  assert.equal(parseConfig().modules, undefined)
  const { modules: empty, ...defaults } = parseConfig({ modules: {} })
  assert.deepEqual(empty, {})
  assert.deepEqual(defaults, parseConfig())
  assert.equal(parseConfig({ modules: { example: { models: ["p/m"] } } }).modules?.example.models[0].cooldownMs, 300_000)
})

test("validates module names, profile shape, model references, and duplicate models", () => {
  for (const modules of [null, [], "opr-jev"]) {
    assert.throws(() => parseConfig({ modules }), /modules: expected an object/)
  }
  for (const id of ["", " ", " opr-jev", "opr-jev "]) {
    assert.throws(() => parseConfig({ modules: { [id]: { models: ["p/m"] } } }), /expected a non-empty string without surrounding whitespace/)
  }
  for (const profile of [null, [], "p/m", {}, { models: [] }, { models: "p/m" }]) {
    assert.throws(() => parseConfig({ modules: { example: profile } }), /modules\.example: expected/)
  }
  assert.throws(() => parseConfig({ modules: { example: { models: ["p/m"], timeoutMs: 100 } } }), /modules\.example\.timeoutMs: unknown field/)
  for (const model of [null, {}, 1, "unqualified", "/model", "p/", "p/white space", { id: "p/m", variant: " " }]) {
    assert.throws(() => parseConfig({ modules: { example: { models: [model] } } }), /modules\.example\.models\[0\]/)
  }
  assert.throws(() => parseConfig({ modules: { example: { models: [{ id: "p/m", extra: true }] } } }), /models\[0\]\.extra: unknown field/)
  for (const models of [["p/m", "p/m"], [{ id: "p/m", variant: "fast" }, { id: "p/m", variant: "slow" }]]) {
    assert.throws(() => parseConfig({ modules: { example: { models } } }), /models\[1\]: duplicate model candidate/)
  }
  assert.throws(() => parseConfig({ plans: { review: [{ id: "p/m", cooldownMs: 10 }] } }), /plans\.review\[0\]\.cooldownMs: unknown field/)
  assert.equal(parseConfig({ plans: { review: [{ id: "p/m", variant: "fast" }, { id: "p/m", variant: "slow" }] } }).plans.review.length, 2)
})

test("validates every module cooldown even when a model overrides it", () => {
  for (const cooldownMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "100", null]) {
    assert.throws(() => parseConfig({ modules: { example: { cooldownMs, models: [{ id: "p/m", cooldownMs: 1 }] } } }), /modules\.example\.cooldownMs: expected a positive safe integer/)
    assert.throws(() => parseConfig({ modules: { example: { models: [{ id: "p/m", cooldownMs }] } } }), /modules\.example\.models\[0\]\.cooldownMs: expected a positive safe integer/)
    assert.throws(() => parseConfig({ providerCooldownMs: cooldownMs, modules: { example: { cooldownMs: 1, models: ["p/m"] } } }), /providerCooldownMs: expected a positive safe integer/)
  }
  assert.equal(parseConfig({ modules: { example: { models: [{ id: "p/m", cooldownMs: Number.MAX_SAFE_INTEGER }] } } }).modules?.example.models[0].cooldownMs, Number.MAX_SAFE_INTEGER)
})

test("module examples in public docs parse with the documented cooldowns", async () => {
  for (const path of ["../README.md", "../docs/PLUGIN_INTEGRATION.md"]) {
    const text = await readFile(new URL(path, import.meta.url), "utf8")
    const section = text.split("Direct-call module profiles")[1]
    const example = section?.match(/```json\r?\n([\s\S]*?)\r?\n```/)?.[1]
    assert.ok(example, `${path} must include a module configuration example`)
    const profile = parseConfig(JSON.parse(example)).modules?.["opr-jev"]
    assert.deepEqual(profile?.models, [
      { providerID: "opencode", modelID: "jev-1.13-free", cooldownMs: 900_000 },
      { providerID: "opencode", modelID: "jev-1.13", cooldownMs: 300_000 },
    ])
  }
})

test("rejects empty plans, malformed refs, duplicate candidates, and invalid variants", () => {
  assert.throws(() => parseConfig({ plans: { review: [] } }), /plans\.review: expected a non-empty array/)
  assert.throws(() => parseConfig({ plans: { review: ["not-qualified"] } }), /plans\.review\[0\]\.id: expected providerID\/modelID/)
  assert.throws(() => parseConfig({ plans: { review: ["p/m", "p/m"] } }), /plans\.review\[1\]: duplicate model candidate/)
  assert.throws(() => parseConfig({ plans: { review: [{ id: "p/m", variant: " " }] } }), /plans\.review\[0\]\.variant/)
})

test("rejects bindings to unknown plans and unknown options", () => {
  assert.throws(() => parseConfig({ plans: { review: ["p/m"] }, agents: { reviewer: "missing" } }), /agents\.reviewer: unknown plan "missing"/)
  assert.throws(() => parseConfig({ plans: { review: ["p/m"] }, workTypes: { audit: "missing" } }), /workTypes\.audit: unknown plan "missing"/)
  assert.throws(() => parseConfig({ cooldown: 10 }), /options\.cooldown: unknown field/)
  assert.throws(() => parseConfig({ usageSources: { p: "other" } }), /usageSources\.p: expected one of go, codex, cursor/)
  assert.throws(() => parseConfig({ quotaExemptModels: ["bad"] }), /quotaExemptModels\[0\]: expected providerID\/modelID/)
  assert.throws(() => parseConfig({ quotaExemptModels: ["p/m", "p/m"] }), /quotaExemptModels\[1\]: duplicate model exemption/)
})

test("rejects invalid durations and non-loopback local endpoints", () => {
  assert.throws(() => parseConfig({ providerCooldownMs: 0 }), /providerCooldownMs: expected a positive safe integer/)
  assert.throws(() => parseConfig({ localHealthTimeoutMs: 1.5 }), /localHealthTimeoutMs: expected a positive safe integer/)
  assert.throws(() => parseConfig({ localEndpoints: { ollama: "https://example.com" } }), /localEndpoints\.ollama: expected a loopback HTTP\(S\) URL/)
  assert.throws(() => parseConfig({ localEndpoints: { ollama: "http://user:secret@localhost:11434" } }), /localEndpoints\.ollama: expected a loopback HTTP\(S\) URL/)
})

test("parses disjoint shared rate-limit groups", () => {
  assert.deepEqual(parseConfig({
    sharedRateLimits: [["opencode/deepseek-v4.1-flash-free", "opencode/glm-5.3-flash-free", "opencode/mimo-v2.6-flash-free"]],
  }).sharedRateLimits, [[
    { providerID: "opencode", modelID: "deepseek-v4.1-flash-free" },
    { providerID: "opencode", modelID: "glm-5.3-flash-free" },
    { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
  ]])
  assert.deepEqual(parseConfig({ sharedRateLimits: [] }).sharedRateLimits, [])
  assert.throws(() => parseConfig({ sharedRateLimits: [["p/m"]] }), /sharedRateLimits\[0\]: expected at least two models/)
  assert.throws(() => parseConfig({ sharedRateLimits: [["p/m", "p/m"]] }), /duplicate model in group/)
  assert.throws(() => parseConfig({ sharedRateLimits: [["p/a", "p/b"], ["p/b", "p/c"]] }), /belongs to another shared rate-limit group/)
  assert.throws(() => parseConfig({ sharedRateLimits: "p/m" }), /sharedRateLimits: expected an array of model groups/)
})
test("parses an optional exclusive model list", () => {
  assert.deepEqual(parseConfig({ exclusiveModels: ["ninfer/qwen3-27b"] }).exclusiveModels, [
    { providerID: "ninfer", modelID: "qwen3-27b" },
  ])
  assert.deepEqual(parseConfig({ exclusiveModels: [] }).exclusiveModels, [])
  assert.throws(() => parseConfig({ exclusiveModels: ["bad"] }), /exclusiveModels\[0\]: expected providerID\/modelID/)
  assert.throws(() => parseConfig({ exclusiveModels: [" p/m"] }), /without surrounding whitespace/)
  assert.throws(() => parseConfig({ exclusiveModels: ["p/m", "p/m"] }), /duplicate exclusive model/)
  assert.throws(() => parseConfig({ exclusiveModels: "p/m" }), /exclusiveModels: expected an array/)
})
