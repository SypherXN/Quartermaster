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

test("preserves slashes inside provider model IDs", () => {
  assert.deepEqual(parseConfig({ plans: { review: ["openrouter/vendor/model"] } }).plans.review[0], {
    providerID: "openrouter",
    modelID: "vendor/model",
  })
})

test("allows no bindings and accepts custom durations", () => {
  assert.deepEqual(parseConfig({}), {
    plans: {}, agents: {}, workTypes: {}, usageSources: {}, quotaExemptModels: [],
    providerCooldownMs: 300_000, localHealthTimeoutMs: 2_000, localEndpoints: {},
  })
  assert.equal(parseConfig({ providerCooldownMs: 30, localHealthTimeoutMs: 50 }).providerCooldownMs, 30)
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
