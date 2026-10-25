import assert from "node:assert/strict"
import { resolve } from "node:path"
import test from "node:test"
import { ensureLocalUi, localUiOwnerCount, watchLocalUiParent } from "../src/local-ui.mjs"

test("local UI parent watch stops when the parent is gone", async () => {
  assert.equal(watchLocalUiParent(0), undefined)
  assert.equal(watchLocalUiParent(process.pid), undefined)
  let immediate = 0
  const stopNow = watchLocalUiParent(4321, { isAlive: () => false, onGone: () => { immediate += 1 } })
  assert.equal(immediate, 1)
  stopNow?.()

  let alive = true
  let gone = 0
  const stop = watchLocalUiParent(4321, {
    isAlive: () => alive,
    onGone: () => { gone += 1 },
    intervalMs: 15,
  })
  assert.equal(gone, 0)
  alive = false
  await new Promise((done) => setTimeout(done, 50))
  assert.equal(gone, 1)
  stop?.()
})

test("plugin startup keeps the local UI attached and the last owner stops it", async () => {
  const directory = process.cwd()
  const env = { QUARTERMASTER_LOCAL_UI_PORT: "43111" }
  let child
  const spawnImpl = (_exe, _args, options) => {
    child = {
      options,
      killed: false,
      exitCode: null,
      kill() { this.killed = true },
      unref() {},
      stderr: { setEncoding() {}, on() {}, unref() {} },
    }
    return child
  }
  let probes = 0
  let stop
  let extraStop
  try {
    const started = await ensureLocalUi({
      projectDirectory: directory,
      env,
      scriptPath: "src/local-ui.mjs",
      attempts: 2,
      sleep: async () => {},
      connect: async () => { probes += 1; return probes > 1 },
      retain(fn) { stop = fn },
      spawnImpl,
    })
    assert.equal(started, "started")
    assert.equal(child.options.detached, false)
    assert.equal(child.options.cwd, resolve(directory))
    assert.equal(child.options.env.QUARTERMASTER_GATEWAY_CHILD, "1")
    assert.equal(child.options.env.QUARTERMASTER_LOCAL_UI_OPEN_BROWSER, "0")
    assert.equal(child.options.env.QUARTERMASTER_LOCAL_UI_PARENT_PID, String(process.pid))
    assert.equal(localUiOwnerCount(), 1)
    const again = await ensureLocalUi({
      projectDirectory: directory,
      env,
      connect: async () => true,
      spawnImpl: () => { throw new Error("owned spawn") },
      retain(fn) { extraStop = fn },
    })
    assert.equal(again, "running")
    assert.equal(localUiOwnerCount(), 2)
    extraStop()
    assert.equal(child.killed, false)
    stop()
    assert.equal(child.killed, true)
    assert.equal(localUiOwnerCount(), 0)
  } finally {
    extraStop?.()
    stop?.()
  }
})
