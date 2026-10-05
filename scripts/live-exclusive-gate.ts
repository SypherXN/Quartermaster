import { bindExclusive, ExclusiveLeases } from "../src/exclusive.ts"

const model = { providerID: "ninfer", modelID: "qwen3.8-27b" }
const leases = new ExclusiveLeases()
const changes: boolean[] = []
let request: (input: {
  sessionID: string
  agent: string
  kind: string
  model: { providerID: string; id: string }
}) => Promise<void> = async () => {}
const queued: Array<{ event: unknown; done: () => void }> = []
let waiting: ((item: { event: unknown; done: () => void } | undefined) => void) | undefined
let signal: AbortSignal | undefined

const gate = await bindExclusive({
  session: {
    hook: async (_name: string, callback: typeof request) => {
      request = callback
      return { dispose: async () => {} }
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

const push = (event: unknown) => new Promise<void>((done) => {
  const item = { event, done }
  if (waiting) waiting(item)
  else queued.push(item)
})

async function ask(prompt: string, maxTokens: number) {
  const started = Date.now()
  const response = await fetch("http://127.0.0.1:8080/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer local" },
    body: JSON.stringify({
      model: "qwen3.8-27b",
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0,
    }),
  })
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
  return { status: response.status, ms: Date.now() - started, text: body.choices?.[0]?.message?.content ?? "" }
}

const requested = { providerID: "ninfer", id: "qwen3.8-27b" }
const first = (async () => {
  await request({ sessionID: "holder-session", agent: "holder", kind: "primary", model: requested })
  return ask("Write one short paragraph about rivers. Stop after four sentences.", 180)
})()

await new Promise((resolve) => setTimeout(resolve, 100))
let secondPassed = false
const second = (async () => {
  await request({ sessionID: "waiter-session", agent: "waiter", kind: "primary", model: requested })
  secondPassed = true
  return ask("Reply with the single word pong.", 16)
})()

await new Promise((resolve) => setTimeout(resolve, 400))
const waitingWhileFirstRuns = secondPassed === false && leases.blocks("waiter", model)
const holder = await first
const stillWaitingAfterHolderReturns = secondPassed === false
await push({ type: "session.step.ended", data: { sessionID: "holder-session" } })
const waiter = await second
await gate.dispose()

console.log(JSON.stringify({
  modelUnchanged: requested.providerID === "ninfer" && requested.id === "qwen3.8-27b",
  waitingWhileFirstRuns,
  stillWaitingAfterHolderReturns,
  slotChanges: changes,
  holder: { status: holder.status, ms: holder.ms, text: holder.text },
  waiter: { status: waiter.status, ms: waiter.ms, text: waiter.text },
}, null, 2))
