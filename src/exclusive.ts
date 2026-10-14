import type { Context } from "@opencode/plugin/promise/plugin"
import type { ModelRef } from "./config.ts"
import { modelKey } from "./select.ts"

export const EXCLUSIVE_TTL_MS = 15 * 60 * 1000

interface Hold {
  sessionID: string
  agentID: string
  count: number
  reserved: boolean
  expiresAt: number
}

type Sleeper = (ms: number) => { promise: Promise<void>; cancel: () => void }

const defaultSleep: Sleeper = (ms) => {
  let timer: ReturnType<typeof setTimeout>
  return {
    promise: new Promise((resolve) => {
      timer = setTimeout(resolve, ms)
      timer.unref?.()
    }),
    cancel: () => clearTimeout(timer),
  }
}

export class ExclusiveLeases {
  private holds = new Map<string, Hold>()
  private waiters = new Map<string, Set<() => void>>()
  private now: () => number
  private sleep: Sleeper

  constructor(now: () => number = Date.now, sleep: Sleeper = defaultSleep) {
    this.now = now
    this.sleep = sleep
  }

  blocks(sessionID: string, model: Pick<ModelRef, "providerID" | "modelID">): boolean {
    const hold = this.live(modelKey(model))
    return hold !== undefined && hold.sessionID !== sessionID
  }

  peekBlocks(sessionID: string, model: Pick<ModelRef, "providerID" | "modelID">): boolean {
    const hold = this.holds.get(modelKey(model))
    return hold !== undefined && this.now() < hold.expiresAt && hold.sessionID !== sessionID
  }

  taken(model: Pick<ModelRef, "providerID" | "modelID">): boolean {
    return this.live(modelKey(model)) !== undefined
  }

  claim(model: Pick<ModelRef, "providerID" | "modelID">, sessionID: string, agentID: string): "acquired" | "nested" | "busy" {
    return this.tryAcquire(modelKey(model), sessionID, agentID)
  }

  reserve(model: Pick<ModelRef, "providerID" | "modelID">, sessionID: string, agentID: string): "acquired" | "nested" | "busy" {
    const key = modelKey(model)
    const hold = this.live(key)
    const expiresAt = this.now() + EXCLUSIVE_TTL_MS
    if (!hold) {
      this.holds.set(key, { sessionID, agentID, count: 0, reserved: true, expiresAt })
      return "acquired"
    }
    if (hold.sessionID !== sessionID) return "busy"
    hold.reserved = true
    hold.expiresAt = expiresAt
    hold.agentID = agentID
    return "nested"
  }

  async acquire(
    model: Pick<ModelRef, "providerID" | "modelID">,
    sessionID: string,
    agentID: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const key = modelKey(model)
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError")
      const result = this.tryAcquire(key, sessionID, agentID)
      if (result !== "busy") return result === "acquired"
      const delay = Math.max(0, (this.holds.get(key)?.expiresAt ?? this.now()) - this.now())
      await this.pause(key, delay, signal)
    }
  }

  release(sessionID: string): boolean {
    let freed = false
    for (const [key, hold] of [...this.holds]) {
      if (this.now() >= hold.expiresAt) {
        this.holds.delete(key)
        this.wake(key)
        freed = true
        continue
      }
      if (hold.sessionID !== sessionID) continue
      if (hold.count > 0) hold.count -= 1
      if (hold.count > 0 || hold.reserved) continue
      this.holds.delete(key)
      this.wake(key)
      freed = true
    }
    return freed
  }

  releaseReservation(sessionID: string): boolean {
    let freed = false
    for (const [key, hold] of [...this.holds]) {
      if (this.now() >= hold.expiresAt) {
        this.holds.delete(key)
        this.wake(key)
        freed = true
        continue
      }
      if (hold.sessionID !== sessionID) continue
      hold.reserved = false
      if (hold.count > 0) continue
      this.holds.delete(key)
      this.wake(key)
      freed = true
    }
    return freed
  }

  releaseModelReservation(model: Pick<ModelRef, "providerID" | "modelID">, sessionID: string): boolean {
    const key = modelKey(model)
    const hold = this.live(key)
    if (!hold || hold.sessionID !== sessionID) return false
    hold.reserved = false
    if (hold.count > 0) return false
    this.holds.delete(key)
    this.wake(key)
    return true
  }

  finish(sessionID: string): boolean {
    let freed = false
    for (const [key, hold] of [...this.holds]) {
      if (this.now() >= hold.expiresAt) {
        this.holds.delete(key)
        this.wake(key)
        freed = true
        continue
      }
      if (hold.sessionID !== sessionID) continue
      this.holds.delete(key)
      this.wake(key)
      freed = true
    }
    return freed
  }

  touch(sessionID: string): void {
    const expiresAt = this.now() + EXCLUSIVE_TTL_MS
    for (const [key, hold] of [...this.holds]) {
      if (this.now() >= hold.expiresAt) {
        this.holds.delete(key)
        this.wake(key)
        continue
      }
      if (hold.sessionID === sessionID) hold.expiresAt = expiresAt
    }
  }

  private tryAcquire(key: string, sessionID: string, agentID: string): "acquired" | "nested" | "busy" {
    const hold = this.live(key)
    const expiresAt = this.now() + EXCLUSIVE_TTL_MS
    if (!hold) {
      this.holds.set(key, { sessionID, agentID, count: 1, reserved: false, expiresAt })
      return "acquired"
    }
    if (hold.sessionID !== sessionID) return "busy"
    hold.count += 1
    hold.expiresAt = expiresAt
    hold.agentID = agentID
    return "nested"
  }

  private live(key: string): Hold | undefined {
    const hold = this.holds.get(key)
    if (!hold) return undefined
    if (this.now() < hold.expiresAt) return hold
    this.holds.delete(key)
    this.wake(key)
    return undefined
  }

  private wake(key: string) {
    const set = this.waiters.get(key)
    if (!set) return
    this.waiters.delete(key)
    for (const finish of [...set]) finish()
  }

  private pause(key: string, ms: number, signal?: AbortSignal) {
    const sleeper = this.sleep(ms)
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const set = this.waiters.get(key) ?? new Set<() => void>()
      const stop = (abort: boolean) => {
        if (settled) return
        settled = true
        sleeper.cancel()
        set.delete(finish)
        if (this.waiters.get(key) === set && set.size === 0) this.waiters.delete(key)
        signal?.removeEventListener("abort", onAbort)
        if (abort) reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"))
        else resolve()
      }
      const finish = () => stop(false)
      const onAbort = () => stop(true)
      set.add(finish)
      this.waiters.set(key, set)
      void sleeper.promise.then(finish)
      if (signal?.aborted) onAbort()
      else signal?.addEventListener("abort", onAbort, { once: true })
    })
  }
}

function readStep(event: unknown): { kind: "touch" | "release" | "finish" | "delete"; sessionID: string } | undefined {
  if (typeof event !== "object" || event === null) return undefined
  const record = event as { type?: unknown; data?: unknown }
  if (typeof record.data !== "object" || record.data === null) return undefined
  const sessionID = (record.data as { sessionID?: unknown }).sessionID
  if (typeof sessionID !== "string" || sessionID.length === 0) return undefined
  if (record.type === "session.step.streamed") return { kind: "touch", sessionID }
  if (record.type === "session.step.ended" || record.type === "session.step.failed") return { kind: "release", sessionID }
  if (
    record.type === "session.execution.succeeded"
    || record.type === "session.execution.failed"
    || record.type === "session.execution.interrupted"
  ) return { kind: "finish", sessionID }
  if (record.type === "session.deleted") return { kind: "delete", sessionID }
  return undefined
}

export async function bindExclusive(
  ctx: {
    session?: Pick<Context["session"], "hook">
    event?: Pick<Context["event"], "subscribe">
  },
  leases: ExclusiveLeases,
  models: readonly ModelRef[],
  onChange: (changed: boolean) => void | Promise<void>,
  onStep?: (step: { kind: "touch" | "release" | "finish" | "delete"; sessionID: string }) => void | Promise<void>,
) {
  if (!ctx.session || !ctx.event || (models.length === 0 && !onStep)) return { dispose: async () => {} }
  const listed = new Set(models.map((model) => modelKey(model)))
  const controller = new AbortController()
  const hooks: Array<{ dispose: () => Promise<void> }> = []
  for (const providerID of new Set(models.map((model) => model.providerID))) {
    hooks.push(await ctx.session.hook("model.request", async (input) => {
      if (input.kind !== "primary") return
      const model = { providerID: input.model.providerID, modelID: input.model.id }
      if (!listed.has(modelKey(model))) return
      try {
        await onChange(await leases.acquire(model, input.sessionID, input.agent, controller.signal))
      } catch (error) {
        if (controller.signal.aborted) return
        throw error
      }
    }, { providerID }))
  }
  const subscription = (async () => {
    try {
      for await (const event of ctx.event!.subscribe({ signal: controller.signal })) {
        if (controller.signal.aborted) return
        const step = readStep(event)
        if (!step) continue
        await onStep?.(step)
        if (step.kind === "touch") leases.touch(step.sessionID)
        else if (step.kind === "finish" || step.kind === "delete") await onChange(leases.finish(step.sessionID))
        else await onChange(leases.release(step.sessionID))
      }
    } catch {
      if (!controller.signal.aborted) console.warn("[quartermaster] exclusive session watch failed")
    }
  })()
  return {
    dispose: async () => {
      controller.abort()
      await Promise.all(hooks.map((hook) => hook.dispose()))
      await subscription
    },
  }
}
