export interface TokenCounts {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface TokenEventContext {
  projectID?: string
  parentSessionID?: string
  agentID?: string
  model?: {
    providerID: string
    modelID: string
    variant?: string
  }
}

export interface TokenTelemetryRecord {
  hostContractVersion: "2.0.18"
  hostEventID: string
  sourceEvent: "session.step.ended" | "session.step.failed"
  hostSessionID: string
  hostMessageID: string
  hostProjectID: string | null
  parentSessionID: string | null
  hostAgentID: string | null
  providerID: string | null
  modelID: string | null
  variant: string | null
  completedAt: number
  counts: TokenCounts | null
  usageStatus: "reported" | "missing"
  partial: boolean
  // Host USD for this step. Absent on rows stored before the field existed.
  hostCostUSD?: number | null
}

export type TokenEventContextResolver = (
  eventID: string,
  sessionID: string,
  messageID: string,
) => TokenEventContext | undefined

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function hostCostUSD(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function tokenCounts(value: unknown): { counts: TokenCounts; partial: boolean } | null {
  if (!isObject(value)) return null

  const { input, output, reasoning } = value
  if (!isFiniteNumber(input) || !isFiniteNumber(output)) return null

  let partial = false
  let reasoningVal = 0
  if (isFiniteNumber(reasoning)) reasoningVal = reasoning
  else partial = true

  const cache = isObject(value.cache) ? value.cache : {}
  if (!isObject(value.cache)) partial = true

  let cacheRead = 0
  if (isFiniteNumber(cache.read)) cacheRead = cache.read
  else partial = true

  let cacheWrite = 0
  if (isFiniteNumber(cache.write)) cacheWrite = cache.write
  else partial = true

  return {
    counts: { input, output, reasoning: reasoningVal, cacheRead, cacheWrite },
    partial,
  }
}

function projectEvent(
  event: unknown,
  contextForEvent: TokenEventContextResolver,
): TokenTelemetryRecord | undefined {
  if (!isObject(event) || !isObject(event.data)) return undefined
  if (event.type !== "session.step.ended" && event.type !== "session.step.failed") return undefined

  const eventID = nonEmptyString(event.id)
  const sessionID = nonEmptyString(event.data.sessionID)
  const messageID = nonEmptyString(event.data.assistantMessageID)
  if (!eventID || !sessionID || !messageID || typeof event.created !== "number" || !Number.isFinite(event.created)) {
    return undefined
  }

  const context = contextForEvent(eventID, sessionID, messageID)
  const model = context?.model
  const providerID = nonEmptyString(model?.providerID)
  const modelID = nonEmptyString(model?.modelID)
  const hasModel = providerID !== undefined && modelID !== undefined
  const parsed = tokenCounts(event.data.tokens)

  return {
    hostContractVersion: "2.0.18",
    hostEventID: eventID,
    sourceEvent: event.type,
    hostSessionID: sessionID,
    hostMessageID: messageID,
    hostProjectID: nonEmptyString(context?.projectID) ?? null,
    parentSessionID: nonEmptyString(context?.parentSessionID) ?? null,
    hostAgentID: nonEmptyString(context?.agentID) ?? null,
    providerID: hasModel ? providerID : null,
    modelID: hasModel ? modelID : null,
    variant: hasModel ? nonEmptyString(model?.variant) ?? null : null,
    completedAt: event.created,
    counts: parsed?.counts ?? null,
    usageStatus: parsed ? "reported" : "missing",
    partial: parsed?.partial ?? false,
    hostCostUSD: hostCostUSD(event.data.cost),
  }
}

export function projectTokenEvents(
  events: readonly unknown[],
  contextForEvent: TokenEventContextResolver = () => undefined,
): TokenTelemetryRecord[] {
  const records = new Map<string, TokenTelemetryRecord>()
  for (const event of events) {
    const record = projectEvent(event, contextForEvent)
    if (record && !records.has(record.hostEventID)) records.set(record.hostEventID, record)
  }
  return [...records.values()]
}
