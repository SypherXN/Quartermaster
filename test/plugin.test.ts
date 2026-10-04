import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../src/index.ts"

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

test("plugin loads and disposes without changing agent configuration", async () => {
  assert.equal(plugin.id, "quartermaster")
  assert.equal(typeof plugin.setup, "function")

  const cleanup = await plugin.setup(fakeContext({ rpc: fakeRpc() }) as never)
  if (typeof cleanup === "function") await cleanup()
})

test("plugin rejects invalid configured options during setup", async () => {
  await assert.rejects(
    () => Promise.resolve().then(() => plugin.setup({ options: { plans: { review: [] } } } as never)),
    /plans\.review: expected a non-empty array/,
  )
})

test("missing usage RPC does not prevent plugin startup", async () => {
  const ctx = {
    ...fakeContext(),
    options: { usageSources: { "provider-a": "codex" } },
    rpc: fakeRpc(async () => { throw new Error("RPC not found") }),
  }
  const cleanup = await plugin.setup(ctx as never)
  if (typeof cleanup === "function") await cleanup()
})
