// session.step.ended does not name a model. session.step.started does, for that
// step alone. Pair them in order per assistant message. A session's current
// model is never a substitute.

export interface StepModel {
  providerID: string
  modelID: string
  variant: string | null
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : undefined

export function projectStepStart(event: unknown): { eventID: string; messageID: string; model: StepModel } | undefined {
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
  private claimed = new Map<string, StepModel | null>()
  private skip = new Map<string, number>()
  private seen = new Set<string>()

  observe(event: unknown) {
    const start = projectStepStart(event)
    if (!start || this.seen.has(start.eventID)) return
    this.seen.add(start.eventID)
    if (this.seen.size > 2_000) {
      const oldest = this.seen.values().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
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
    if (this.claimed.has(eventID)) return this.claimed.get(eventID) ?? undefined
    const queue = this.pending.get(messageID)
    const next = queue?.shift()
    if (queue && queue.length === 0) this.pending.delete(messageID)
    if (!next) {
      this.skip.set(messageID, (this.skip.get(messageID) ?? 0) + 1)
      this.remember(eventID, null)
      return undefined
    }
    this.remember(eventID, next)
    return next
  }

  private remember(eventID: string, model: StepModel | null) {
    this.claimed.set(eventID, model)
    if (this.claimed.size <= 2_000) return
    const oldest = this.claimed.keys().next().value
    if (oldest !== undefined) this.claimed.delete(oldest)
  }
}
