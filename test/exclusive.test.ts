import assert from "node:assert/strict"
import test from "node:test"
import { bindExclusive, EXCLUSIVE_TTL_MS, ExclusiveLeases } from "../src/exclusive.ts"

const model = { providerID: "ninfer", modelID: "qwen" }
const hang = () => ({ promise: new Promise<void>(() => {}), cancel() {} })

test("diagnostic lease checks neither release holds nor prune expired entries", () => {
  let now = 0
  const leases = new ExclusiveLeases(() => now)
  leases.reserve(model, "a", "reviewer")
  assert.equal(leases.peekBlocks("a", model), false)
  assert.equal(leases.peekBlocks("b", model), true)
  now = EXCLUSIVE_TTL_MS
  assert.equal(leases.peekBlocks("b", model), false)
  now = 0
  assert.equal(leases.peekBlocks("b", model), true, "inspection did not delete the stored hold")
})

test("one session holds an exclusive model until its nested steps end", async () => {
  const leases = new ExclusiveLeases(() => 0, hang)
  assert.equal(await leases.acquire(model, "a", "reviewer"), true)
  assert.equal(await leases.acquire(model, "a", "reviewer"), false)
  assert.equal(leases.blocks("b", model), true)
  assert.equal(leases.blocks("a", model), false)
  assert.equal(leases.release("missing"), false)
  assert.equal(leases.blocks("b", model), true)

  let finished = false
  const pending = leases.acquire(model, "b", "builder").then((changed) => {
    finished = true
    return changed
  })
  await Promise.resolve()
  assert.equal(finished, false)
  assert.equal(leases.release("a"), false)
  await Promise.resolve()
  assert.equal(finished, false)
  assert.equal(leases.release("a"), true)
  assert.equal(await pending, true)
  assert.equal(leases.blocks("a", model), true)
})

test("a streamed step extends the hold and silence expires it", async () => {
  let now = 0
  const quiet = new ExclusiveLeases(() => now)
  await quiet.acquire(model, "a", "reviewer")
  now = EXCLUSIVE_TTL_MS
  assert.equal(quiet.blocks("b", model), false)

  now = 0
  const refreshed = new ExclusiveLeases(() => now)
  await refreshed.acquire(model, "a", "reviewer")
  now = EXCLUSIVE_TTL_MS - 1
  refreshed.touch("a")
  now = EXCLUSIVE_TTL_MS
  assert.equal(refreshed.blocks("b", model), true)
  now = EXCLUSIVE_TTL_MS - 1 + EXCLUSIVE_TTL_MS
  assert.equal(refreshed.blocks("b", model), false)
})

test("a waiting session acquires after the hold expires", async () => {
  let now = 0
  const leases = new ExclusiveLeases(() => now, () => ({
    promise: Promise.resolve().then(() => { now = EXCLUSIVE_TTL_MS }),
    cancel() {},
  }))
  assert.equal(await leases.acquire(model, "a", "reviewer"), true)
  assert.equal(await leases.acquire(model, "b", "builder"), true)
  assert.equal(leases.blocks("b", model), false)
  assert.equal(leases.blocks("a", model), true)
})

test("primary calls take the slot and later calls wait for the step", async () => {
  let now = 0
  const leases = new ExclusiveLeases(() => now, hang)
  const changes: boolean[] = []
  let request: (input: { sessionID: string; agent: string; kind: string; model: { providerID: string; id: string } }) => Promise<void> = async () => {}
  let disposed = false
  const queued: Array<{ event: unknown; done: () => void }> = []
  let waiting: ((item: { event: unknown; done: () => void } | undefined) => void) | undefined
  let signal: AbortSignal | undefined
  const gate = await bindExclusive({
    session: {
      hook: async (_name: string, callback: typeof request) => {
        request = callback as typeof request
        return { dispose: async () => { disposed = true } }
      },
    },
    event: {
      subscribe(input: { signal?: AbortSignal }) {
        signal = input.signal
        return (async function* () {
          while (!signal?.aborted) {
            const item = queued.shift() ?? await new Promise<typeof queued[number] | undefined>((resolve) => {
              let settled = false
              const finish = (value?: typeof queued[number]) => {
                if (settled) return
                settled = true
                waiting = undefined
                resolve(value)
              }
              waiting = finish
              signal?.addEventListener("abort", () => finish(), { once: true })
            })
            if (!item || signal?.aborted) return
            yield item.event
            item.done()
          }
        })()
      },
    },
  } as never, leases, [model], async (changed) => { changes.push(changed) })

  const requested = { providerID: "ninfer", id: "qwen" }
  await request({ sessionID: "a", agent: "reviewer", kind: "compaction", model: requested })
  await request({ sessionID: "a", agent: "reviewer", kind: "primary", model: { providerID: "ninfer", id: "other" } })
  assert.deepEqual(changes, [])
  await request({ sessionID: "a", agent: "reviewer", kind: "primary", model: requested })
  assert.deepEqual(requested, { providerID: "ninfer", id: "qwen" })
  assert.equal(leases.blocks("b", model), true)
  const push = (event: unknown) => new Promise<void>((done) => {
    const item = { event, done }
    if (waiting) waiting(item)
    else queued.push(item)
  })
  await push({ type: "session.step.failed", data: { sessionID: "nobody" } })
  now = EXCLUSIVE_TTL_MS - 1
  await push({ type: "session.step.streamed", data: { sessionID: "a" } })
  now = EXCLUSIVE_TTL_MS
  assert.equal(leases.blocks("b", model), true)
  let second = false
  const pending = request({ sessionID: "b", agent: "builder", kind: "primary", model: requested }).then(() => { second = true })
  await Promise.resolve()
  assert.equal(second, false)
  await push({ type: "session.step.ended", data: { sessionID: "a" } })
  await pending
  assert.equal(second, true)
  assert.deepEqual(changes, [true, false, true, true])
  await gate.dispose()
  assert.equal(disposed, true)
})
