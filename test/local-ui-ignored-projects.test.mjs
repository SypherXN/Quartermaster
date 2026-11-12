import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createLocalUiServer } from "../src/local-ui.mjs"

test("dashboard ignores are reversible; read failures fail open; pruning never applies user ignores", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qm-ignore-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registration = join(root, "opencode.json")
  const settings = join(root, "quartermaster.jsonc")
  const info = { plugins: [{ package: "quartermaster" }] }
  await writeFile(registration, JSON.stringify(info))
  await writeFile(settings, JSON.stringify({ ignoredProjectDirectories: ["C:/work/ignored"] }))
  let failConfig = false
  let configReads = 0
  let reportInput
  let pruneInput
  const rows = [
    { id: "ignored", canonical: "c:\\WORK\\ignored\\child" },
    { id: "sibling", canonical: "C:/work/ignored-other" },
    { id: "reviewer", canonical: "C:/work/permission-reviewer-isolation/sandbox" },
    { id: "temp", canonical: join(tmpdir(), "sandbox") },
    { id: "chat", canonical: "C:/openchamber/chats/thread" },
  ]
  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    res.setHeader("content-type", "application/json")
    if (path === "/api/location") return res.end(JSON.stringify({ directory: root, project: { id: "project-a", directory: root } }))
    if (path === "/api/project") return res.end(JSON.stringify(rows))
    if (path === "/api/config") {
      configReads++
      if (failConfig) { res.statusCode = 500; return res.end("{}") }
      return res.end(JSON.stringify([{ type: "document", path: registration, info }]))
    }
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()).input : {}
    if (path.endsWith("/report")) reportInput = input
    if (path.endsWith("/pruneUnlisted")) pruneInput = input
    const output = path.endsWith("/status")
      ? { apiVersion: 1, plans: {}, agents: {}, workTypes: {}, sources: {} }
      : { apiVersion: 1, status: "ok", totals: {}, costs: {} }
    res.end(JSON.stringify({ output }))
  })
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => upstream.close(resolve)))
  const local = createLocalUiServer({ openCodeURL: `http://127.0.0.1:${upstream.address().port}`, token: "test-only", projectDirectory: root, port: 0 })
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => local.close(resolve)))
  const origin = `http://127.0.0.1:${local.address().port}`
  const dashboard = async () => {
    assert.equal((await fetch(`${origin}/api/dashboard`)).status, 200)
    return new Map(reportInput.projects.map((entry) => [entry.id, entry]))
  }
  let view = await dashboard()
  assert.equal(view.get("ignored").exclude, true)
  assert.equal(view.get("sibling").exclude, undefined)
  assert.equal(view.get("reviewer").exclude, true)
  assert.equal(view.get("temp").exclude, true)
  assert.equal(view.get("chat").bucket, "openchamber-chats")
  const reads = configReads
  assert.equal((await fetch(`${origin}/api/prune-unlisted`, { method: "POST" })).status, 200)
  assert.equal(configReads, reads, "pruning must not read user exclusions")
  assert.ok(pruneInput.projects.includes("ignored"))
  assert.ok(pruneInput.projects.includes("sibling"))
  assert.ok(!pruneInput.projects.includes("reviewer"))
  assert.ok(!pruneInput.projects.includes("temp"))
  assert.ok(!pruneInput.projects.includes("unlisted-projects"))
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), { ignoredProjectDirectories: ["C:/work/ignored"] })
  failConfig = true
  view = await dashboard()
  assert.equal(view.get("ignored").exclude, undefined)
  assert.equal(view.get("reviewer").exclude, true)
  failConfig = false
  const loaded = await (await fetch(`${origin}/api/options`)).json()
  assert.equal((await fetch(`${origin}/api/options`, {
    method: "POST", body: JSON.stringify({ revision: loaded.revision, options: { ignoredProjectDirectories: ["relative"] } }),
  })).status, 400)
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), loaded.options, "invalid lists never partially apply")
  assert.equal((await fetch(`${origin}/api/options`, {
    method: "POST", body: JSON.stringify({ revision: loaded.revision, options: { ignoredProjectDirectories: [] } }),
  })).status, 200)
  view = await dashboard()
  assert.equal(view.get("ignored").exclude, undefined)
})
