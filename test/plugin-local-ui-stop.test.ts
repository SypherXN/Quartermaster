import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../src/index.ts"

const storage = {
  get: async () => undefined,
  set: async () => {},
  remove: async () => {},
  scan: async () => ({ entries: [] }),
}

function fakeRpc() {
  return Object.assign(() => ({ status: async () => ({}) }), {
    register: async () => ({ dispose() {} }),
  })
}

function context(extra: Record<string, unknown>) {
  return {
    location: { directory: "C:\\work", project: { id: "project-test" } },
    event: { subscribe: () => (async function* () {})() },
    session: { get: async () => { throw new Error("not used") }, hook: async () => ({ dispose() {} }) },
    storage,
    rpc: fakeRpc(),
    ...extra,
  }
}

test("plugin shutdown stops the local UI it started", async () => {
  let stopped = false
  const cleanup = await plugin.setup(context({
    quartermasterLocalUi: async (_directory: string, options?: { retain?: (stop: () => void) => void }) => {
      options?.retain?.(() => { stopped = true })
      return "started"
    },
  }) as never)
  assert.equal(stopped, false)
  if (typeof cleanup !== "function") throw new Error("plugin setup did not return cleanup")
  await cleanup()
  assert.equal(stopped, true)
})

test("plugin setup failure stops the local UI it started", async () => {
  let stopped = false
  await assert.rejects(() => plugin.setup(context({
    quartermasterLocalUi: async (_directory: string, options?: { retain?: (stop: () => void) => void }) => {
      options?.retain?.(() => { stopped = true })
      return "started"
    },
    storage: { ...storage, get: async () => { throw new Error("storage down") } },
  }) as never), /storage down/)
  assert.equal(stopped, true)
})
