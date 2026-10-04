import type { ModelRef, QuartermasterConfig } from "./config.ts"
import { modelKey } from "./select.ts"

export const PIN_STORAGE_KEY = "pins/v1"

interface PinStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export class AgentPins {
  private readonly pins = new Map<string, ModelRef>()
  private readonly config: Pick<QuartermasterConfig, "plans" | "agents">
  private registry: readonly ModelRef[]
  private readonly storage: PinStorage

  private constructor(
    config: Pick<QuartermasterConfig, "plans" | "agents">,
    registry: readonly ModelRef[],
    storage: PinStorage,
  ) {
    this.config = config
    this.registry = registry
    this.storage = storage
  }

  static async load(
    config: Pick<QuartermasterConfig, "plans" | "agents">,
    registry: readonly ModelRef[],
    storage: PinStorage,
  ): Promise<AgentPins> {
    const result = new AgentPins(config, registry, storage)
    const stored = await storage.get(PIN_STORAGE_KEY)
    if (!isRecord(stored)) return result

    for (const [agentID, value] of Object.entries(stored)) {
      try {
        result.pins.set(agentID, result.validate(agentID, value))
      } catch {
        // Ignore pins that no longer match the current configuration or registry.
      }
    }
    return result
  }

  get(agentID: string): ModelRef | undefined {
    return this.pins.get(agentID)
  }

  snapshot(): ReadonlyMap<string, ModelRef> {
    return new Map(this.pins)
  }

  setRegistry(registry: readonly ModelRef[]): void {
    this.registry = registry
  }

  async pin(agentID: string, model: unknown): Promise<ModelRef> {
    const normalized = this.validate(agentID, model)
    this.pins.set(agentID, normalized)
    await this.persist()
    return normalized
  }

  async unpin(agentID: string): Promise<boolean> {
    this.assertBoundAgent(agentID)
    if (!this.pins.delete(agentID)) return false
    await this.persist()
    return true
  }

  private assertBoundAgent(agentID: string): readonly ModelRef[] {
    const planID = Object.hasOwn(this.config.agents, agentID) ? this.config.agents[agentID] : undefined
    if (planID === undefined) throw new Error(`agents.${agentID}: agent has no configured plan`)
    return this.config.plans[planID]
  }

  private validate(agentID: string, value: unknown): ModelRef {
    const plan = this.assertBoundAgent(agentID)
    if (!isRecord(value) || typeof value.providerID !== "string" || typeof value.modelID !== "string") {
      throw new Error(`pins.${agentID}: expected a configured providerID/modelID`)
    }
    for (const field of Object.keys(value)) {
      if (!["providerID", "modelID", "variant"].includes(field)) {
        throw new Error(`pins.${agentID}.${field}: unknown field`)
      }
    }
    if (value.variant !== undefined && typeof value.variant !== "string") {
      throw new Error(`pins.${agentID}.variant: expected a string`)
    }

    const key = modelKey({ providerID: value.providerID, modelID: value.modelID })
    const candidate = plan.find((entry) =>
      modelKey(entry) === key && (value.variant === undefined || entry.variant === value.variant),
    )
    if (!candidate) throw new Error(`pins.${agentID}: model is not a candidate in its configured plan`)
    if (!this.registry.some((entry) => modelKey(entry) === key)) {
      throw new Error(`pins.${agentID}: model is not enabled in the OpenCode model registry`)
    }
    return candidate
  }

  private persist(): Promise<void> {
    return this.storage.set(PIN_STORAGE_KEY, Object.fromEntries(this.pins))
  }
}
