import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { normalizeUsageSnapshot } from "../dist/usage.js"

// No prompts, credential recovery or usage refresh: inspect the receiving host only.
const host = process.env.OPENCODE_PERMISSION_REVIEWER_HOST_URL
assert.match(host ?? "", /^http:\/\/127\.0\.0\.1:\d+$/)
const directory = resolve(".")
const exe = join(homedir(), ".opencode", "bin", "opencode.exe")
const expected = { "opencode-go": "go", openai: "codex", cursor: "cursor" }
const paths = [join(homedir(), ".config", "opencode", "opencode.json"), join(directory, "opencode.json")]
const backups = process.argv.slice(2)
assert.equal(backups.length, 2, "Provide the approved global and project pre-edit backups")
const api = (method, path, body) => {
  const scoped = path + "?" + new URLSearchParams({ "location[directory]": directory })
  const args = ["api", "--server", host, method, scoped]
  if (body !== undefined) args.push("--data", JSON.stringify(body))
  const r = spawnSync(exe, args, { encoding: "utf8", timeout: 30_000, windowsHide: true })
  assert.equal(r.status, 0, `${method} ${path}: ${r.error?.message ?? r.stderr}`)
  return JSON.parse(r.stdout)
}
const rpc = (id, method, input = {}) => api("post", `/api/rpc/${id}/${method}`, { input }).output
const options = (config) => {
  const entries = config.plugins.filter((entry) => typeof entry.package === "string" && entry.package.includes("Quartermaster"))
  assert.equal(entries.length, 1)
  return entries[0].options
}
const configs = []
for (let i = 0; i < paths.length; i++) {
  const current = JSON.parse(await readFile(paths[i], "utf8"))
  const prior = JSON.parse(await readFile(backups[i], "utf8"))
  assert.deepEqual(options(current).usageSources, expected)
  const withoutMapping = structuredClone(current)
  delete options(withoutMapping).usageSources
  assert.deepEqual(withoutMapping, prior, "Only the approved quota map may differ from backup")
  configs.push(current)
}
const [global, project] = configs.map(options)
const catalog = api("get", "/api/model").data
for (const providerID of [...Object.keys(expected), "ninfer"]) {
  assert.ok(catalog.some((model) => model.providerID === providerID), `Unregistered provider: ${providerID}`)
}
const usage = normalizeUsageSnapshot(rpc("opencode-usage", "status"))
assert.equal(usage.status, "ok", "Cached usage must satisfy Quartermaster's schema")
assert.deepEqual(Object.keys(usage.snapshot.sources).sort(), ["codex", "cursor", "go"])
const healthURL = project.localEndpoints.ninfer
assert.equal(healthURL, global.localEndpoints.ninfer)
assert.equal(healthURL, "http://127.0.0.1:8080/v1/models")
let health
try {
  const response = await fetch(healthURL, { method: "GET", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(2_000) })
  health = { status: response.ok ? "online" : "offline", httpStatus: response.status }
  await response.body?.cancel()
} catch {
  health = { status: "offline", reason: "bounded loopback health GET could not connect" }
}
const explanation = rpc("quartermaster", "explain", { agent: "qm-test" })
const status = rpc("quartermaster", "status")
assert.equal(status.status, "ok")
assert.deepEqual(status.agents, project.agents)
assert.deepEqual(Object.keys(status.plans).sort(), Object.keys(project.plans).sort())
assert.deepEqual(Object.fromEntries(Object.entries(status.sources).map(([provider, source]) => [provider, source.sourceID])), expected)
const local = rpc("quartermaster", "readOptions")
assert.equal(local.status, "ok")
assert.deepEqual(local.options, project)
// An earlier owned fixture session is deliberately foreign: no live user session is touched.
const diagnostic = rpc("quartermaster", "diagnoseSession", { sessionID: "ses_edea515d8ffev5bbzJvPInX8TP" })
assert.equal(resolve(diagnostic.location.directory), directory)
assert.equal(diagnostic.session.model, "unknown")
assert.equal(diagnostic.availability.quota, "ok")
assert.equal(diagnostic.availability.localHealth.ninfer, health.status)
const reviewer = rpc("opencode-permission-reviewer", "status")
assert.equal(reviewer.active, true)
assert.equal(reviewer.variant, "medium")
const proof = {
  recordedAt: new Date().toISOString(), host, runtime: diagnostic.runtime, location: diagnostic.location,
  backups, mappings: expected, registeredProviderIDs: [...Object.keys(expected), "ninfer"],
  health: { url: healthURL, ...health }, quota: diagnostic.availability.quota,
  sources: Object.fromEntries(Object.entries(status.sources).map(([provider, source]) => [provider, {
    sourceID: source.sourceID, authenticated: source.authenticated, checkedAt: source.checkedAt,
    stale: source.stale, availability: source.availability,
  }])),
  effectiveAgents: status.agents, planIDs: Object.keys(status.plans), explanationStatus: explanation.status,
  reviewer: { active: reviewer.active, generation: reviewer.generation, variant: reviewer.variant },
  limits: ["Account-to-provider associations were confirmed by the user, not inferred from names.",
    "Cached usage only; no refresh, prompt or inference.",
    "Current direct project document verified; not a full ancestor/config-format precedence audit.",
    "Foreign-session diagnostic establishes location/runtime only, not live session ownership."],
}
const evidenceDirectory = await mkdtemp(join(homedir(), "AppData", "Local", "Temp", "opencode", "qm-setup-"))
const file = join(evidenceDirectory, "setup-proof.json")
await writeFile(file, JSON.stringify(proof, null, 2))
console.log(JSON.stringify({ file, mappings: expected, health: proof.health, quota: proof.quota, reviewer: proof.reviewer }, null, 2))
