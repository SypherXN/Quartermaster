import assert from "node:assert/strict"
import test from "node:test"
import {
  modelsDevPricesFromData, readModelsDevPrices, resetModelsDevCache,
} from "../src/telemetry/models-dev.ts"
import {
  pricesFromModels, quotaPricesFromModels, readQuotaPriceTable, resetPriceCache,
  type CatalogModelLike,
} from "../src/telemetry/prices.ts"

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

function data() {
  return {
    openai: {
      models: {
        "gpt-6-luna": {
          id: "gpt-6-luna", name: "GPT-6 Luna",
          cost: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
        },
        "gpt-7-new": { id: "gpt-7-new", name: "GPT-7 New", cost: { input: 2, output: 8 } },
        tiered: {
          id: "tiered", name: "Tiered",
          cost: { input: 1, output: 2, tiers: [{ input: 3, output: 4, tier: { type: "context", size: 200_000 } }] },
        },
        legacy: {
          id: "legacy", name: "Legacy",
          cost: { input: 5, output: 6, context_over_200k: { input: 7, output: 8 } },
        },
        zero: { id: "zero", name: "Zero", cost: { input: 0, output: 0 } },
        broken: { id: "broken", name: "Broken", cost: { input: Number.NaN, output: 1 } },
      },
    },
    anthropic: {
      models: {
        opus: { id: "claude-opus-5-5", name: "Claude Opus 5.5", cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } },
        duplicateA: { name: "Claude Duplicate", cost: { input: 1, output: 2 } },
        duplicateB: { name: "Claude Duplicate", cost: { input: 3, output: 4 } },
      },
    },
    other: { models: { ignored: { id: "ignored", cost: { input: 1, output: 1 } } } },
  }
}

function hostModels(): CatalogModelLike[] {
  return [
    { providerID: "openai", id: "gpt-6-luna", modelID: "upstream-luna", name: "GPT-6 Luna" },
    { providerID: "openai", id: "gpt-7-new", modelID: "upstream-7", name: "GPT-7 New" },
    { providerID: "openai", id: "gpt-6-unknown", modelID: "upstream-unknown", name: "GPT-6 Unknown" },
    { providerID: "claude-agent", id: "opus", modelID: "upstream-opus", name: "Opus 5.5" },
    { providerID: "claude-agent", id: "mystery", modelID: "upstream-mystery", name: "Mystery 1" },
    { providerID: "claude-agent", id: "duplicate", modelID: "upstream-duplicate", name: "Duplicate" },
  ]
}

test("parses only first-party provider prices with tiers and known cache fields", () => {
  const parsed = modelsDevPricesFromData(data())
  assert.ok(parsed)
  const luna = parsed.openai.get("gpt-6-luna")
  assert.ok(luna)
  assert.deepEqual(luna[0], {
    tierSize: null, input: 0.1, output: 0.5,
    cacheRead: 0.01, cacheReadKnown: true, cacheWrite: 0.125, cacheWriteKnown: true,
  })
  const tiered = parsed.openai.get("tiered")
  assert.ok(tiered)
  assert.equal(tiered.length, 2)
  assert.equal(tiered[1].tierSize, 200_000)
  assert.equal(tiered[1].cacheReadKnown, false)
  assert.equal(parsed.openai.get("legacy")?.[1].tierSize, 200_000)
  assert.equal(parsed.openai.has("zero"), false)
  assert.equal(parsed.openai.has("broken"), false)
  assert.equal(parsed.openai.has("ignored"), false)
  assert.equal(parsed.anthropicByName.get("Claude Duplicate"), null)
  assert.equal(parsed.anthropicByName.get("Claude Opus 5.5")?.[0].input, 4)
})

test("matches subscription models exactly and leaves unknown or ambiguous ones unpriced", () => {
  const models = hostModels()
  const api = modelsDevPricesFromData(data())
  const quota = quotaPricesFromModels(models, api)
  assert.equal(quota.get("openai/gpt-6-luna")?.[0].input, 0.1)
  assert.equal(quota.get("openai/gpt-7-new")?.[0].input, 2)
  assert.equal(quota.has("openai/gpt-6-unknown"), false)
  assert.equal(quota.get("claude-agent/opus")?.[0].input, 4)
  assert.equal(quota.has("claude-agent/mystery"), false)
  assert.equal(quota.has("claude-agent/duplicate"), false)
  // Ordinary cost-report prices remain keyed by upstream IDs and unpriced.
  assert.equal(pricesFromModels(models).has("openai/gpt-6-luna"), false)
  // A direct positive host price outranks the fetched row.
  const direct = models.map((model) =>
    model.id === "gpt-6-luna" ? { ...model, cost: [{ input: 9, output: 18 }] } : model)
  assert.equal(quotaPricesFromModels(direct, api).get("openai/gpt-6-luna")?.[0].input, 9)
  // With no fetched data, the static alias fallback still works where defined.
  const staticHost = [
    { providerID: "openai", id: "gpt-6-luna", modelID: "upstream-luna", name: "GPT-6 Luna" },
    { providerID: "opencode", id: "gpt-6-luna", modelID: "opencode-luna", name: "GPT-6 Luna", cost: [{ input: 7, output: 14 }] },
  ]
  assert.equal(quotaPricesFromModels(staticHost, undefined).get("openai/gpt-6-luna")?.[0].input, 7)
})

function rollingData(opusLatest: { name: string; cost?: ReturnType<typeof costRow>[] }[] = []) {
  const models: Record<string, unknown> = {
    "opus-5-9": { id: "claude-opus-5-9", name: "Claude Opus 5.9", cost: { input: 59, output: 0 } },
    "opus-5-10": { id: "claude-opus-5-10", name: "Claude Opus 5.10", cost: { input: 510, output: 0 } },
    "opus-preview": { id: "claude-opus-7-preview", name: "Claude Opus 7 Preview", cost: { input: 700, output: 0 } },
    "opus-fast": { id: "claude-opus-7-fast", name: "Claude Opus 7", cost: { input: 701, output: 0 } },
    "opus-dated": { id: "claude-opus-8-20260101", name: "Claude Opus 8", cost: { input: 800, output: 0 } },
    sonnet: { id: "claude-sonnet-6", name: "Claude Sonnet 6", cost: { input: 6, output: 0 } },
    haiku: { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", cost: { input: 55, output: 0 } },
    fable: { id: "claude-fable-5", name: "Claude Fable 5", cost: { input: 50, output: 0 } },
    "fable-6": { id: "claude-fable-6", name: "Claude Fable 6", cost: { input: 60, output: 0 } },
  }
  let index = 0
  for (const entry of opusLatest) {
    index += 1
    models[`opus-extra-${index}`] = {
      id: `claude-opus-extra-${index}`, name: entry.name,
      ...(entry.cost === undefined ? {} : { cost: { input: entry.cost[0].input, output: 0 } }),
    }
  }
  return { openai: { models: {} }, anthropic: { models } }
}

function costRow(input: number, output: number) {
  return { input, output, cache: { read: 0, write: 0 } }
}

test("rolling Claude aliases follow the newest numeric family version, not the stale display name", () => {
  const api = modelsDevPricesFromData(rollingData())
  assert.ok(api)
  const host: CatalogModelLike[] = [
    { providerID: "claude-agent", id: "opus", modelID: "opus", name: "Opus 5.5" },
    { providerID: "claude-agent", id: "sonnet", modelID: "sonnet", name: "Sonnet 5.5" },
    { providerID: "claude-agent", id: "haiku", modelID: "haiku", name: "Haiku 5.5" },
    { providerID: "claude-agent", id: "fable", modelID: "fable", name: "Fable 4.5" },
    { providerID: "claude-agent", id: "opus-5-9", modelID: "opus-5-9", name: "Opus 5.9" },
  ]
  const quota = quotaPricesFromModels(host, api)
  assert.equal(quota.get("claude-agent/opus")?.[0].input, 510)
  assert.equal(quota.get("claude-agent/sonnet")?.[0].input, 6)
  assert.equal(quota.get("claude-agent/haiku")?.[0].input, 55)
  assert.equal(quota.get("claude-agent/fable")?.[0].input, 60)
  // Explicit versioned IDs remain exact.
  assert.equal(quota.get("claude-agent/opus-5-9")?.[0].input, 59)
})

test("a newer unpriced or ambiguous family does not fall back to an older price", () => {
  const unpriced = modelsDevPricesFromData(rollingData([{ name: "Claude Opus 6" }]))
  assert.ok(unpriced)
  const host: CatalogModelLike[] = [
    { providerID: "claude-agent", id: "opus", modelID: "opus", name: "Opus 5.5" },
    {
      providerID: "opencode", id: "claude-opus-5-5", modelID: "claude-opus-5-5",
      name: "Claude Opus 5.5", cost: [costRow(999, 0)],
    },
  ]
  assert.equal(quotaPricesFromModels(host, unpriced).has("claude-agent/opus"), false)

  const ambiguous = modelsDevPricesFromData(rollingData([
    { name: "Claude Opus 6", cost: [costRow(600, 0)] },
    { name: "Claude Opus 6", cost: [costRow(601, 0)] },
  ]))
  assert.ok(ambiguous)
  assert.equal(quotaPricesFromModels(host, ambiguous).has("claude-agent/opus"), false)
})


test("caches successes for 6h, serves stale on error up to 7d, and backs off failures", async () => {
  resetModelsDevCache()
  let clock = 0
  let calls = 0
  let fail = false
  const fetchImpl = (async () => {
    calls += 1
    if (fail) throw new Error("down")
    return response(data())
  }) as unknown as typeof fetch

  const first = await readModelsDevPrices({ fetch: fetchImpl, now: () => clock })
  assert.ok(first)
  assert.equal(calls, 1)
  clock = 6 * HOUR - 1
  await readModelsDevPrices({ fetch: fetchImpl, now: () => clock })
  assert.equal(calls, 1)

  clock = 6 * HOUR
  fail = true
  const stale = await readModelsDevPrices({ fetch: fetchImpl, now: () => clock })
  assert.ok(stale)
  assert.equal(stale.openai.get("gpt-6-luna")?.[0].input, 0.1)
  assert.equal(calls, 2)

  clock += 10 * 60_000 - 1
  await readModelsDevPrices({ fetch: fetchImpl, now: () => clock })
  assert.equal(calls, 2)
  clock += 2
  await readModelsDevPrices({ fetch: fetchImpl, now: () => clock })
  assert.equal(calls, 3)

  clock = 7 * DAY + 1
  const gone = await readModelsDevPrices({ fetch: fetchImpl, now: () => clock })
  assert.equal(gone, undefined)
  assert.equal(calls, 4)
})

test("shares one in-flight fetch and rejects oversized responses", async () => {
  resetModelsDevCache()
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const fetchImpl = (async () => {
    calls += 1
    await gate
    return response(data())
  }) as unknown as typeof fetch
  const first = readModelsDevPrices({ fetch: fetchImpl, now: () => 0 })
  const second = readModelsDevPrices({ fetch: fetchImpl, now: () => 0 })
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.deepEqual(a, b)

  resetModelsDevCache()
  let bigCalls = 0
  const big = (async () => {
    bigCalls += 1
    return new Response("{}", {
      status: 200,
      headers: { "content-length": String(10 * 1024 * 1024 + 1) },
    })
  }) as unknown as typeof fetch
  assert.equal(await readModelsDevPrices({ fetch: big, now: () => 0 }), undefined)
  assert.equal(bigCalls, 1)
})

test("readQuotaPriceTable fetches only when enabled and falls back to static aliases", async () => {
  const host: CatalogModelLike[] = [
    { providerID: "openai", id: "gpt-6-luna", modelID: "upstream-luna", name: "GPT-6 Luna" },
  ]
  const staticHost: CatalogModelLike[] = [
    ...host,
    { providerID: "opencode", id: "gpt-6-luna", modelID: "opencode-luna", name: "GPT-6 Luna", cost: [{ input: 7, output: 14 }] },
  ]
  const list = async () => ({ data: host })
  const staticList = async () => ({ data: staticHost })

  resetPriceCache()
  resetModelsDevCache()
  let calls = 0
  const fake = (async () => { calls += 1; return response(data()) }) as unknown as typeof fetch
  const disabled = await readQuotaPriceTable(list, () => 0, { fetchApiPrices: false, fetch: fake })
  assert.equal(calls, 0)
  assert.equal(disabled.has("openai/gpt-6-luna"), false)

  resetPriceCache()
  resetModelsDevCache()
  const fetched = await readQuotaPriceTable(list, () => 0, { fetch: fake })
  assert.equal(calls, 1)
  assert.equal(fetched.get("openai/gpt-6-luna")?.[0].input, 0.1)

  resetPriceCache()
  resetModelsDevCache()
  const down = (async () => { throw new Error("down") }) as unknown as typeof fetch
  const fallback = await readQuotaPriceTable(staticList, () => 0, { fetch: down })
  assert.equal(fallback.get("openai/gpt-6-luna")?.[0].input, 7)
})

test("wait:false returns the static table without waiting for the network", async () => {
  const staticHost: CatalogModelLike[] = [
    { providerID: "openai", id: "gpt-6-luna", modelID: "upstream-luna", name: "GPT-6 Luna" },
    { providerID: "opencode", id: "gpt-6-luna", modelID: "opencode-luna", name: "GPT-6 Luna", cost: [{ input: 7, output: 14 }] },
  ]
  resetPriceCache()
  resetModelsDevCache()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  const fake = (async () => {
    calls += 1
    await gate
    return response(data())
  }) as unknown as typeof fetch
  const table = await readQuotaPriceTable(async () => ({ data: staticHost }), () => 0, { fetch: fake, wait: false })
  assert.equal(table.get("openai/gpt-6-luna")?.[0].input, 7)
  assert.equal(calls, 1)
  release()
  await readModelsDevPrices({ fetch: fake, now: () => 0 })
  resetModelsDevCache()
  resetPriceCache()
})
