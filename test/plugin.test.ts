import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import plugin from "../src/index.ts"
import { MODULE_COOLDOWN_STORAGE_KEY, type ModuleSelection } from "../src/modules.ts"
import { fixtureConfiguration } from "./configuration-fixture.ts"

function fakeRpc(status = async () => ({})) {
  return Object.assign(() => ({ status }), {
    register: async () => ({ dispose() {} }),
  })
}

async function* noEvents() {}

const storage = {
  get: async () => undefined,
  set: async () => {},
  remove: async () => {},
  scan: async () => ({ entries: [] }),
}

function fakeContext(extra: Record<string, unknown> = {}) {
  return {
    location: { project: { id: "project-test" } },
    event: { subscribe: () => noEvents() },
    session: {
      get: async () => { throw new Error("not used") },
      hook: async () => ({ dispose() {} }),
    },
    storage,
    ...extra,
  }
}

async function settingsProject(settings: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "qm-plugin-"))
  await writeFile(join(directory, "opencode.json"), JSON.stringify({ plugins: [{ package: "quartermaster" }] }))
  await writeFile(join(directory, "quartermaster.jsonc"), `${JSON.stringify(settings, null, 2)}\n`)
  return directory
}

test("plugin loads and disposes without changing agent configuration", async () => {
  assert.equal(plugin.id, "quartermaster")
  assert.equal(typeof plugin.setup, "function")

  const cleanup = await plugin.setup(fakeContext({ rpc: fakeRpc() }) as never)
  if (typeof cleanup === "function") await cleanup()
})

test("plugin rejects settings left on the plugin entry", async () => {
  await assert.rejects(
    async () => plugin.setup(fakeContext({ options: { plans: { review: [] } } }) as never),
    /quartermaster\.jsonc beside the OpenCode config/,
  )
})

test("an invalid settings file does not stop startup", async () => {
  const directory = await settingsProject({ plans: { review: [] } })
  try {
    const cleanup = await plugin.setup(fakeContext({
      location: { directory, project: { id: "project-test" } },
      quartermasterConfigurationReader: fixtureConfiguration,
      rpc: fakeRpc(),
    }) as never)
    if (typeof cleanup === "function") await cleanup()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("missing usage RPC does not prevent plugin startup", async () => {
  const directory = await settingsProject({ usageSources: { "provider-a": "codex" } })
  const warnings: unknown[][] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    const ctx = fakeContext({
      location: { directory, project: { id: "project-test" } },
      quartermasterConfigurationReader: fixtureConfiguration,
      rpc: fakeRpc(async () => { throw new Error("RPC not found") }),
    })
    const cleanup = await plugin.setup(ctx as never)
    if (typeof cleanup === "function") await cleanup()
    assert.match(warnings.map((entry) => entry.join(" ")).join("\n"), /opencode-usage status unavailable/)
  } finally {
    console.warn = warn
    await rm(directory, { recursive: true, force: true })
  }
})

test("modules-only startup supports recommendation status without native capabilities", async () => {
  const directory = await settingsProject({ modules: { opr: { models: ["opencode/jev-free", "opencode/jev-paid"] } } })
  let handlers: Record<string, (input: unknown) => Promise<Record<string, unknown>>> | undefined
  let disposed = false
  const reads: string[] = []
  const forbidden = new Proxy({}, { get: () => { throw new Error("native access forbidden") } })
  const rpc = Object.assign(() => { throw new Error("external RPC forbidden") }, {
    register: async (_definition: unknown, methods: typeof handlers) => {
      handlers = methods
      return { dispose: async () => { disposed = true; handlers = undefined } }
    },
  })
  const ctx = fakeContext({
    location: { directory, project: { id: "project-test" } },
    quartermasterConfigurationReader: fixtureConfiguration,
    agent: forbidden, model: forbidden, session: undefined, rpc,
    storage: { ...storage, get: async (key: string) => {
      reads.push(key)
      return { cooldowns: [{ module: "opr", providerID: "opencode", modelID: "jev-free", until: Number.MAX_SAFE_INTEGER }] }
    } },
  })
  const cleanup = await plugin.setup(ctx as never)
  try {
    assert.deepEqual(reads, [`${MODULE_COOLDOWN_STORAGE_KEY}/project-test`])
    const status = await handlers!.status({})
    assert.equal(status.status, "unconfigured", "native status is unchanged")
    const result = (status.modules as Record<string, ModuleSelection>).opr
    if (result.status !== "selected") throw new Error("expected paid recommendation")
    assert.deepEqual(result.selected, { providerID: "opencode", modelID: "jev-paid" })
    assert.equal(result.candidates[0].reason, "cooldown")
    assert.equal(result.candidates[1].health, "unknown")
    assert.equal((await handlers!.select({ agent: "reviewer" })).status, "no-plan")
    assert.equal(typeof handlers!.selectModule, "function")
  } finally {
    if (typeof cleanup === "function") await cleanup()
    await rm(directory, { recursive: true, force: true })
  }
  assert.equal(disposed, true)
})
