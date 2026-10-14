import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

// Exercises managed-host gaps that #42 did not prove. Queued reselection stays unsupported.
export async function runRoutingProof({ fixture, proof, api, trace, control, diagnose, session, prompt, idle, until }) {
  const cooldownMs = 30_000
  const config = JSON.parse(await readFile(join(fixture.directory, "opencode.json"), "utf8"))
  assert.equal(config.plugins[0].options.providerCooldownMs, cooldownMs)
  assert.equal(config.plugins[0].options.usageSources, undefined, "the main fixture must not read live quota")
  const info = api("get", "/api/info")
  // Record separate boundary runs for this artifact; old checkout proofs are not release evidence.
  const snap = (id) => {
    const data = api("get", `/api/session/${id}`).data
    return { agent: data.agent, model: data.model, outcome: data.outcome, idle: data.time?.idle !== undefined }
  }
  const rows = (seen, marker) => seen.requests.filter((row) => row.marker === marker && !row.auxiliary)
  const clean = (row) => !row.delegated && !row.spawnChild
  const arm = async (body) => {
    const response = await fetch(fixture.baseURL + "/failure", {
      method: "POST", headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
    })
    assert.equal(response.status, 204)
  }
  async function send(id, marker, model, variant = null) {
    const before = snap(id)
    prompt(id, marker)
    await until(trace, (value) => rows(value, marker).length > 0, marker)
    await idle(id)
    const primary = rows(await trace(), marker)
    assert.deepEqual(primary.map((row) => [row.model, row.variant ?? null]), [[model, variant]])
    assert.ok(primary.every(clean))
    const report = diagnose(id)
    assert.equal(report.session.model.modelID, model)
    assert.equal(report.session.model.variant ?? "default", variant ?? "default")
    assert.equal(snap(id).model.id, model)
    return { before, after: snap(id), mode: report.session.mode, model: report.session.model }
  }
  const id = session("qm-managed-recover")
  assert.equal(snap(id).model.id, "composer", "client default must differ from the selected model")
  const admission = await send(id, "qm-managed-admission", "selected")
  assert.equal(admission.before.model.id, "composer")
  assert.equal(admission.mode, "automatic")
  const repeated = await send(id, "qm-managed-repeat", "selected")
  assert.equal(repeated.mode, "automatic")
  api("post", `/api/session/${id}/command`, { name: "qm-manual", text: "" })
  api("post", `/api/session/${id}/model`, { model: { providerID: fixture.providers.initial, id: "composer", variant: "deliberate" } })
  const manual = await send(id, "qm-managed-manual", "composer", "deliberate")
  const manualRepeated = await send(id, "qm-managed-manual-repeat", "composer", "deliberate")
  assert.equal(manual.mode, "manual")
  assert.equal(manualRepeated.mode, "manual")
  api("post", `/api/session/${id}/command`, { name: "qm-auto", text: "" })
  const resumed = await send(id, "qm-managed-resume", "selected")
  assert.equal(resumed.mode, "automatic")
  const unbound = session("qm-managed-unbound")
  api("post", `/api/session/${unbound}/model`, { model: { providerID: fixture.providers.initial, id: "composer", variant: "deliberate" } })
  const unboundSend = await send(unbound, "qm-managed-unbound-choice", "composer", "deliberate")
  assert.equal(unboundSend.mode, "unbound")
  await control("/offline")
  let offline, noEligible
  try {
    await delay(5_100)
    offline = await send(id, "qm-managed-offline-skip", "composer")
    assert.equal((await trace()).requests.filter((row) => row.marker === "qm-managed-offline-skip" && row.model === "selected").length, 0)
    const blocked = session("qm-managed-test")
    const before = (await trace()).requests.length
    const rejected = api("post", `/api/session/${blocked}/prompt`, { text: "qm-managed-no-eligible", delivery: "queue", resume: true }, true)
    assert.notEqual(rejected.status, 0, "all-offline automatic admission must reject")
    assert.equal((await trace()).requests.length, before, "no eligible candidate must send no provider request")
    noEligible = { id: blocked, rejected, diagnostic: diagnose(blocked) }
  } finally {
    await control("/online")
    await delay(5_100)
  }
  const quotaDirectory = await mkdtemp(join(dirname(fixture.directory), "qm-quota-"))
  const quotaConfig = structuredClone(config)
  const quotaAdapter = join(quotaDirectory, "quota-adapter")
  await mkdir(quotaAdapter)
  const wrapper = await readFile(new URL("./managed-routing-proof/index.ts", import.meta.url), "utf8")
  await writeFile(join(quotaAdapter, "index.ts"), wrapper.replace('"../../index.js"', JSON.stringify(pathToFileURL(join(fixture.pluginRoot, "index.js")).href)))
  quotaConfig.plugins[0].package = quotaAdapter
  quotaConfig.plugins[0].options.usageSources = { [fixture.providers.selected]: "go" }
  quotaConfig.plugins[0].options.plans.quota = [`${fixture.providers.selected}/selected`, `${fixture.providers.initial}/composer`]
  quotaConfig.plugins[0].options.agents["qm-managed-quota"] = "quota"
  quotaConfig.agents["qm-managed-quota"] = { ...quotaConfig.agents["qm-managed-test"] }
  await writeFile(join(quotaDirectory, "opencode.json"), JSON.stringify(quotaConfig, null, 2))
  const quotaStatus = api("post", "/api/rpc/quartermaster/status", { input: {} }, false, quotaDirectory).output
  const quotaSource = quotaStatus.sources?.[fixture.providers.selected]
  assert.equal(quotaSource?.availability, "limited", "synthetic quota must be visible before claiming a skip")
  assert.equal(quotaSource?.windows?.[0]?.name, "qm-synthetic-limited")
  const created = api("post", "/api/session", { title: "QM synthetic quota", location: { directory: quotaDirectory } }, false, quotaDirectory)
  const quotaID = (created.data ?? created).id
  proof.sessions.push(quotaID)
  api("post", `/api/session/${quotaID}/agent`, { agent: "qm-managed-quota" }, false, quotaDirectory)
  api("post", `/api/session/${quotaID}/model`, { model: { providerID: fixture.providers.initial, id: "composer" } }, false, quotaDirectory)
  api("post", `/api/session/${quotaID}/prompt`, { text: "qm-managed-quota-skip", delivery: "queue", resume: true }, false, quotaDirectory)
  await until(trace, (value) => rows(value, "qm-managed-quota-skip").length > 0, "quota skip")
  await until(() => api("get", `/api/session/${quotaID}`, undefined, false, quotaDirectory).data, (value) => value.time?.idle !== undefined && value.outcome === "succeeded", "quota session")
  const quotaFinal = rows(await trace(), "qm-managed-quota-skip")
  assert.deepEqual(quotaFinal.map((row) => row.model), ["composer"])
  assert.ok(quotaFinal.every(clean))
    const retryID = session("qm-managed-recover")
  await arm({ mode: "rate-limit", remaining: 8, model: "selected" })
  prompt(retryID, "qm-managed-retry")
  await until(trace, (value) => rows(value, "qm-managed-retry").some((row) => row.model === "composer" && row.failure == null), "native retry fallback", 150)
  const retryDone = await idle(retryID)
  const retryPrimary = rows(await trace(), "qm-managed-retry")
  assert.equal(retryPrimary[0].model, "selected")
  assert.equal(retryPrimary[0].failure, "rate-limit")
  assert.ok(retryPrimary.some((row) => row.model === "composer" && row.failure == null))
  assert.ok(retryPrimary.length <= 12, `retry attempts must stay bounded (saw ${retryPrimary.length})`)
  assert.ok(retryPrimary.every(clean))
  const limitedAt = retryPrimary.find((row) => row.failure === "rate-limit").at
  await arm({ mode: "none", remaining: 0 })
  assert.ok(Date.now() < limitedAt + cooldownMs, "follow-up must be admitted before cooldown expiry")
  const cooled = await send(retryID, "qm-managed-cooldown", "composer")
    const remain = limitedAt + cooldownMs - Date.now()
  assert.ok(remain > 1_000, `not enough cooldown left to hold a response (${remain}ms)`)
  await control("/hold")
  let heldDuring
  try {
    prompt(retryID, "qm-managed-held-expiry")
    await until(trace, (value) => value.waiting >= 1 && rows(value, "qm-managed-held-expiry").length === 1, "held follow-up")
    await delay(Math.max(0, limitedAt + cooldownMs + 500 - Date.now()))
    heldDuring = await trace()
    const heldRows = rows(heldDuring, "qm-managed-held-expiry")
    assert.equal(heldRows.length, 1)
    assert.equal(heldRows[0].model, "composer")
    await control("/release")
  } finally { await control("/release") }
  await idle(retryID)
  assert.equal(rows(await trace(), "qm-managed-held-expiry").map((row) => row.model).join(), "composer")
  const promoted = await send(retryID, "qm-managed-promoted", "selected")
  assert.equal(promoted.mode, "automatic")
    const partialID = session("qm-managed-recover")
  api("post", `/api/session/${partialID}/command`, { name: "qm-manual", text: "" })
  api("post", `/api/session/${partialID}/model`, { model: { providerID: fixture.providers.selected, id: "selected", variant: "deliberate" } })
  await arm({ mode: "partial", remaining: 1, model: "selected" })
  prompt(partialID, "qm-managed-partial")
  const partialDone = await until(() => snap(partialID), (value) => value.idle, "partial continuation", 150)
  const partialPrimary = rows(await trace(), "qm-managed-partial")
  assert.equal(partialPrimary[0]?.failure, "partial")
  assert.ok(partialPrimary.length > 0)
  assert.ok(partialPrimary.every((row) => row.model === "selected" && (row.variant ?? null) === "deliberate" && clean(row)))
  assert.equal(diagnose(partialID).session.mode, "manual")
  await arm({ mode: "none", remaining: 0 })
  const exhaustID = session("qm-managed-recover")
  await arm({ mode: "rate-limit", remaining: 40, model: null })
  prompt(exhaustID, "qm-managed-exhaust")
  const exhausted = await until(async () => ({ session: api("get", `/api/session/${exhaustID}`).data, seen: await trace() }), (value) => value.session.time?.idle !== undefined && value.session.outcome && value.session.outcome !== "succeeded", "bounded exhaustion", 450)
  const exhaustPrimary = rows(exhausted.seen, "qm-managed-exhaust")
  assert.ok(exhaustPrimary.length >= 2 && exhaustPrimary.length <= 12, `unexpected attempt count ${exhaustPrimary.length}`)
  assert.ok(exhaustPrimary.some((row) => row.model === "selected") && exhaustPrimary.some((row) => row.model === "composer"))
  assert.ok(exhaustPrimary.every((row) => row.failure === "rate-limit" && clean(row)))
  await arm({ mode: "none", remaining: 0 })
    const auxiliary = (await trace()).requests.filter((row) => row.auxiliary)
  assert.ok(auxiliary.every((row) => row.model === "composer" && clean(row)))
  return {
    info, reviewer: proof.reviewer?.variant,
    queuedLimitation: "Transparent queued reselection remains unsupported and is not claimed here.",
    admission, repeated, manual, manualRepeated, resumed, unbound: unboundSend, offline, noEligible,
    quota: { directory: quotaDirectory, window: quotaSource?.windows?.[0]?.name, availability: quotaSource?.availability, requests: quotaFinal.map((row) => row.model) },
    retry: { id: retryID, outcome: retryDone.outcome, requests: retryPrimary.map((row) => [row.model, row.failure]), finalModel: snap(retryID).model },
    cooled, held: rows(heldDuring, "qm-managed-held-expiry").map((row) => row.model), promoted,
    partial: { id: partialID, outcome: partialDone.outcome, label: "partial-output continuation; not fallback evidence", requests: partialPrimary.map((row) => [row.model, row.failure]) },
    exhaustion: { id: exhaustID, outcome: exhausted.session.outcome, requests: exhaustPrimary.map((row) => row.model) },
    auxiliary: auxiliary.map((row) => ({ model: row.model, marker: row.marker })),
    ui: { directory: fixture.directory, admissionSession: id, retrySession: retryID, quotaDirectory },
  }
}

