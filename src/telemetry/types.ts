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

function tokenCounts(value: unknown): TokenCounts | null {
  if (!isObject(value) || !isObject(value.cache)) return null

  const { input, output, reasoning } = value
  const { read, write } = value.cache
  if (
    !isFiniteNumber(input) ||
    !isFiniteNumber(output) ||
    !isFiniteNumber(reasoning) ||
    !isFiniteNumber(read) ||
    !isFiniteNumber(write)
  ) {
    return null
  }

  return { input, output, reasoning, cacheRead: read, cacheWrite: write }
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
  const counts = tokenCounts(event.data.tokens)

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
    counts,
    usageStatus: counts ? "reported" : "missing",
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
