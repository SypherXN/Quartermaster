// session.step.ended does not name a model. session.step.started does, for that
// step alone. Pair them in order per assistant message. A session's current
// model is never a substitute.

import { performanceSample, type StepPerformance } from "./performance.ts"

export interface StepModel {
  providerID: string
  modelID: string
  variant: string | null
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : undefined

type StepStart = { eventID: string; messageID: string; model: StepModel }

export function projectStepStart(event: unknown): StepStart | undefined {
  if (!isObject(event) || event.type !== "session.step.started" || !isObject(event.data)) return undefined
  const eventID = text(event.id)
  const messageID = text(event.data.assistantMessageID)
  const model = isObject(event.data.model) ? event.data.model : undefined
  const providerID = text(model?.providerID)
  const modelID = text(model?.id) ?? text(model?.modelID)
  if (!eventID || !messageID || !providerID || !modelID) return undefined
  return { eventID, messageID, model: { providerID, modelID, variant: text(model?.variant) ?? null } }
}

export class StepModelClaims {
  private pending = new Map<string, StepModel[]>()
  private claimed = new Map<string, { model?: StepModel; performance?: StepPerformance }>()
  private skip = new Map<string, number>()
  private seen = new Set<string>()
  private timing = new StepTimings()

  observe(event: unknown) {
    if (isObject(event) && event.type === "session.step.started") {
      const id = text(event.id)
      if (!id || this.seen.has(id)) return
      this.seen.add(id)
      if (this.seen.size > 2_000) this.seen.delete(this.seen.values().next().value!)
    }
    const start = projectStepStart(event)
    this.timing.observe(event, start)
    if (!start) return
    const skips = this.skip.get(start.messageID) ?? 0
    if (skips > 0) {
      this.skip.set(start.messageID, skips - 1)
      return
    }
    const queue = this.pending.get(start.messageID) ?? []
    queue.push(start.model)
    this.pending.set(start.messageID, queue)
  }

  claim(eventID: string, messageID: string): StepModel | undefined {
    return this.claimTerminal(eventID, messageID).model
  }

  claimTerminal(eventID: string, messageID: string, event?: unknown) {
    const previous = this.claimed.get(eventID)
    if (previous) return previous
    const queue = this.pending.get(messageID)
    const next = queue?.shift()
    if (queue && queue.length === 0) this.pending.delete(messageID)
    if (!next) this.skip.set(messageID, (this.skip.get(messageID) ?? 0) + 1)
    const result = { model: next, performance: this.timing.complete(event) }
    this.remember(eventID, result)
    return result
  }

  private remember(eventID: string, result: { model?: StepModel; performance?: StepPerformance }) {
    this.claimed.set(eventID, result)
    if (this.claimed.size <= 2_000) return
    const oldest = this.claimed.keys().next().value
    if (oldest !== undefined) this.claimed.delete(oldest)
  }
}

// Usage keeps its legacy FIFO and fallback. Timing needs a unique live pair
// within the exact session/message and uses only the model on that start.
type Timing = {
  open: number
  terminalAt?: number
  terminalID?: string
  orphanAt?: number
  // A retry marker makes the next start for this message ambiguous (the failed
  // attempt's terminal may still arrive), so that start is never timed.
  retried?: boolean
  start?: {
    id: string
    model: StepModel
    at: number
    dispatch: number
    ttftInvalid: boolean
    // The provider response-body boundary was seen twice, disagreeing, or out of order.
    streamedInvalid: boolean
    firstText?: number
    lastText?: number
    streamedAt?: number
  }
}

const MAX_TRACKED = 2_000

const MIN_EPOCH_MS = Date.UTC(2000, 0, 1)
const MAX_EPOCH_MS = Date.UTC(2100, 0, 1)
const epochMs = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) &&
    value >= MIN_EPOCH_MS && value < MAX_EPOCH_MS ? value : undefined

class StepTimings {
  private active = new Map<string, Timing>()
  private recent = new Map<string, Timing>()
  // Keys whose unresolved state was evicted. A step started on one of these is
  // never timed, because the evicted step's terminal could still arrive.
  private lost = new Map<string, true>()

  observe(event: unknown, start: StepStart | undefined): void {
    if (!isObject(event) || !isObject(event.data)) return
    const { type, data } = event
    if (type !== "session.step.started" && type !== "session.step.streamed" && type !== "session.text.delta" &&
      type !== "session.retry.scheduled" && type !== "session.execution.interrupted" && type !== "session.execution.failed") return
    const sessionID = text(data.sessionID)
    if (!sessionID) return
    const messageID = text(data.assistantMessageID)
    const at = epochMs(event.created)
    if (type === "session.execution.interrupted" || type === "session.execution.failed") {
      // An interrupted or failed execution may never emit terminals for its open
      // steps. Drop them so they cannot leak, and fence off anything that arrives
      // later with an earlier timestamp (see complete()).
      const prefix = JSON.stringify([sessionID]).slice(0, -1) + ","
      for (const key of [...this.active.keys()]) {
        if (!key.startsWith(prefix)) continue
        const state = this.active.get(key)!
        state.start = undefined
        state.open = 0
        if (at !== undefined) state.terminalAt = Math.max(state.terminalAt ?? 0, at)
        this.remember(key, state)
      }
      return
    }
    if (!messageID) return
    const key = JSON.stringify([sessionID, messageID])
    if (type === "session.step.started") {
      const state = this.active.get(key) ?? this.recent.get(key) ?? { open: 0 }
      const dispatch = epochMs(data.started)
      const id = text(event.id)
      if (state.start?.id === id || (!state.open && at !== undefined && at < (state.terminalAt ?? 0))) return
      const ambiguous = this.lost.delete(key) || state.retried === true
      state.retried = false
      state.open += 1
      state.start = !ambiguous && state.open === 1 && start && id !== undefined && at !== undefined && dispatch !== undefined &&
        at >= dispatch && dispatch >= (state.terminalAt ?? 0)
        ? { id, model: start.model, at, dispatch, ttftInvalid: dispatch <= (state.orphanAt ?? -1), streamedInvalid: false } : undefined
      this.remember(key, state)
    } else if (type === "session.retry.scheduled") {
      // Whether the failed attempt's terminal already arrived is unknown, so the
      // next start on this message is skipped rather than guessed.
      const state = this.active.get(key) ?? this.recent.get(key) ?? { open: 0 }
      state.start = undefined
      state.open = 0
      state.retried = true
      if (at !== undefined) state.terminalAt = Math.max(state.terminalAt ?? 0, at)
      this.remember(key, state)
    } else if (type === "session.step.streamed" || (type === "session.text.delta" && text(data.delta))) {
      const state = this.active.get(key) ?? this.recent.get(key)
      const step = state?.start
      if (!step) {
        if (!state?.open && at !== undefined) {
          this.remember(key, { ...state, open: 0, orphanAt: Math.max(at, state?.orphanAt ?? 0) })
        }
        return
      }
      if (type === "session.step.streamed") {
        if (at === undefined || at < Math.max(step.at, step.lastText ?? 0) ||
          (step.streamedAt !== undefined && step.streamedAt !== at)) {
          step.streamedInvalid = true
          step.ttftInvalid = true
        } else step.streamedAt = at
      } else if (at === undefined || at < (step.lastText ?? step.at) || step.streamedAt !== undefined) {
        step.ttftInvalid = true
      } else {
        step.firstText ??= at
        step.lastText = at
      }
    }
  }

  complete(event: unknown): StepPerformance | undefined {
    if (!isObject(event) || !isObject(event.data)) return undefined
    const { type, data } = event
    const key = JSON.stringify([data.sessionID, data.assistantMessageID])
    const state = this.active.get(key) ?? this.recent.get(key) ?? { open: 0 }
    const step = state.start
    const at = epochMs(event.created)
    const id = text(event.id)
    if (state.terminalID !== undefined && id === state.terminalID) return undefined
    // A terminal stamped before the current start or the last settled terminal
    // belongs to an earlier step (e.g. after an interruption). It neither pairs
    // with nor clears the current start.
    if (at !== undefined && at < Math.max(step?.at ?? 0, state.terminalAt ?? 0)) return undefined
    state.start = undefined
    state.open = Math.max(0, state.open - 1)
    if (at !== undefined) state.terminalAt = at
    state.terminalID = id
    this.remember(key, state)
    if (!step || at === undefined || at < (step.streamedAt ?? step.at) ||
      type !== "session.step.ended" ||
      (data.finish !== "stop" && data.finish !== "length" && data.finish !== "tool-calls")) return undefined

    // Rate runs from dispatch to the provider response-body boundary, so tool
    // settlement after it is excluded. It still includes request startup and
    // any reasoning, so it is not pure decode speed. No boundary, no rate.
    const elapsed = step.streamedAt !== undefined && !step.streamedInvalid ? step.streamedAt - step.dispatch : undefined
    const output = isObject(data.tokens) ? data.tokens.output : undefined
    const rate = elapsed !== undefined && elapsed > 0 && typeof output === "number" && Number.isSafeInteger(output) && output >= 0
      ? (output * 1_000) / elapsed : undefined
    const ttft = !step.ttftInvalid && step.firstText !== undefined && at >= (step.streamedAt ?? step.lastText ?? step.at)
      ? step.firstText - step.dispatch : undefined
    const histogram = performanceSample(rate, ttft)
    return histogram ? { ...step.model, histogram } : undefined
  }

  private remember(key: string, state: Timing) {
    this.recent.delete(key)
    this.active.delete(key)
    if (state.open > 0) {
      this.active.set(key, state)
      // Evict the least recently touched unresolved step. Its key is remembered
      // as lost so a later start there is skipped instead of looking unique;
      // only this key loses timing, not the subscription.
      if (this.active.size > MAX_TRACKED) {
        const oldest = this.active.keys().next().value!
        this.active.delete(oldest)
        this.lost.set(oldest, true)
        if (this.lost.size > MAX_TRACKED) this.lost.delete(this.lost.keys().next().value!)
      }
    } else {
      this.recent.set(key, state)
      if (this.recent.size > MAX_TRACKED) this.recent.delete(this.recent.keys().next().value!)
    }
  }
}
