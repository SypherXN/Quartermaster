import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import plugin, { startCheckoutLocalUi } from "../src/index.ts"
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
    quartermasterLocalUi: async () => "skipped",
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

test("plugin setup starts the local UI for the loaded project", async () => {
  const calls: string[] = []
  const cleanup = await plugin.setup(fakeContext({
    location: { directory: "C:\\work", project: { id: "project-test" } },
    quartermasterLocalUi: async (directory: string) => {
      calls.push(directory)
      return "running"
    },
    rpc: fakeRpc(),
  }) as never)
  if (typeof cleanup === "function") await cleanup()
  assert.deepEqual(calls, ["C:\\work"])
})

test("plugin shutdown stops the local UI it started", async () => {
  let stopped = false
  const cleanup = await plugin.setup(fakeContext({
    location: { directory: "C:\\work", project: { id: "project-test" } },
    quartermasterLocalUi: async (_directory: string, options?: { retain?: (stop: () => void) => void }) => {
      options?.retain?.(() => { stopped = true })
      return "started"
    },
    rpc: fakeRpc(),
  }) as never)
  assert.equal(stopped, false)
  if (typeof cleanup !== "function") throw new Error("plugin setup did not return cleanup")
  await cleanup()
  assert.equal(stopped, true)
})

test("plugin setup failure stops the local UI it started", async () => {
  let stopped = false
  await assert.rejects(async () => plugin.setup(fakeContext({
    location: { directory: "C:\\work", project: { id: "project-test" } },
    quartermasterLocalUi: async (_directory: string, options?: { retain?: (stop: () => void) => void }) => {
      options?.retain?.(() => { stopped = true })
      return "started"
    },
    storage: { ...storage, get: async () => { throw new Error("storage down") } },
    rpc: fakeRpc(),
  }) as never), /storage down/)
  assert.equal(stopped, true)
})

test("a local UI startup failure does not stop the plugin", async () => {
  const warnings: unknown[][] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    const cleanup = await plugin.setup(fakeContext({
      location: { directory: "C:\\work", project: { id: "project-test" } },
      quartermasterLocalUi: async () => { throw new Error("ui down") },
      rpc: fakeRpc(),
    }) as never)
    if (typeof cleanup === "function") await cleanup()
    assert.match(warnings.map((entry) => entry.join(" ")).join("\n"), /ui down/)
  } finally {
    console.warn = warn
  }
})

test("checkout local UI startup skips, disables, and reports the loopback URL", async () => {
  let loaded = false
  const load = async () => { loaded = true; return { ensureLocalUi: async () => "started" } }
  assert.equal(await startCheckoutLocalUi(undefined, { env: {}, load }), "skipped")
  assert.equal(await startCheckoutLocalUi("  ", { env: {}, load }), "skipped")
  assert.equal(loaded, false)
  assert.equal(await startCheckoutLocalUi("C:\\work", {
    env: { QUARTERMASTER_LOCAL_UI: "0" },
    load,
  }), "disabled")
  assert.equal(loaded, false)
  assert.equal(await startCheckoutLocalUi("C:\\work", {
    env: {},
    scriptUrl: new URL("./missing-local-ui.mjs", import.meta.url),
    load,
  }), "absent")
  assert.equal(loaded, false)
  assert.equal(await startCheckoutLocalUi("C:\\work", {
    env: {},
    load: async () => ({}),
  }), "absent")

  const calls: { projectDirectory: string }[] = []
  const notes: string[] = []
  const info = console.info
  console.info = (...args: unknown[]) => { notes.push(args.join(" ")) }
  try {
    assert.equal(await startCheckoutLocalUi("C:\\work", {
      env: { QUARTERMASTER_LOCAL_UI_PORT: "4188" },
      load: async () => ({
        ensureLocalUi: async (options: { projectDirectory: string }) => {
          calls.push(options)
          return "started"
        },
      }),
    }), "started")
    assert.equal(await startCheckoutLocalUi("C:\\work", {
      env: {},
      load: async () => ({ ensureLocalUi: async () => "running" }),
    }), "running")
    assert.equal(await startCheckoutLocalUi("C:\\work", {
      env: {},
      load: async () => ({ ensureLocalUi: async () => "nope" }),
    }), "unavailable")
    const warn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")) }
    try {
      assert.equal(await startCheckoutLocalUi("C:\\work", {
        env: {},
        load: async () => ({ ensureLocalUi: async () => { throw new Error("bind failed") } }),
      }), "unavailable")
    } finally {
      console.warn = warn
    }
    assert.match(warnings.join("\n"), /bind failed/)
  } finally {
    console.info = info
  }
  assert.deepEqual(calls, [{ projectDirectory: "C:\\work" }])
  assert.match(notes.join("\n"), /http:\/\/127\.0\.0\.1:4188\//)
  assert.equal(notes.length, 1)
})
