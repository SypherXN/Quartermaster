import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import { applyAgentRouting } from "../../src/agent-routing.ts"
import { parseConfig, type ModelRef } from "../../src/config.ts"
import { modelKey, type Availability, type ModelEligibility } from "../../src/select.ts"

const readJson = async (path: string) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"))

async function fixtureConfig() {
  const fixture = await readJson("../fixtures/availability-cycle.json")
  const options = await readJson("../../examples/test-agent/quartermaster.jsonc")
  const config = parseConfig({
    ...options,
    plans: { ...options.plans, "test-agent": fixture.models },
  })
  const agentIDs = Object.entries(config.agents).filter(([, plan]) => plan === "test-agent").map(([id]) => id)
  assert.deepEqual(agentIDs, ["qm-test", "quartermaster-test"])
  return { config, fixture, agentIDs }
}

function editorFor(agent: Record<string, unknown>): Pick<AgentEditor, "get" | "update"> {
  return {
    get: (id: string) => id === agent.id ? agent as never : undefined,
    update: (_id: string, change: (value: never) => void) => change(agent as never),
  } as unknown as Pick<AgentEditor, "get" | "update">
}

test("example keeps its primary agent and defines the required read-only subagent", async () => {
  await fixtureConfig()
  for (const [id, mode] of [["qm-test", "primary"], ["quartermaster-test", "subagent"]]) {
    const definition = await readFile(new URL(`../../examples/test-agent/.opencode/agents/${id}.md`, import.meta.url), "utf8")
    assert.match(definition, new RegExp(`^---\\r?\\ndescription: [^\\n]+\\r?\\nmode: ${mode}\\r?\\n`))
    assert.match(definition, /\r?\npermissions:\r?\n  - action: "\*"\r?\n    resource: "\*"\r?\n    effect: deny\r?\n---\r?\n/)
  }
})

test("synthetic assignments select primary, backup, then recovered primary for both agents", async () => {
  const { config, fixture, agentIDs } = await fixtureConfig()
  const plan = config.plans["test-agent"]
  const registry = fixture.models.map((qualified: string) => {
    const [providerID, ...parts] = qualified.split("/")
    return { providerID, modelID: parts.join("/") }
  })

  for (const agentID of agentIDs) for (const assignment of fixture.assignments) {
    const agent = { id: agentID, model: undefined as unknown }
    const eligibility = new Map<string, ModelEligibility>(
      Object.entries(assignment.availability as Record<string, Availability>).map(([qualified, status]) => {
        const model = registry.find((candidate: ModelRef) => `${candidate.providerID}/${candidate.modelID}` === qualified)
        assert.ok(model, `fixture model ${qualified} is in the registry`)
        return [modelKey(model), { status }] as const
      }),
    )

    applyAgentRouting(editorFor(agent), config, registry, eligibility, 0)

    const selected = plan.find((model: ModelRef) => `${model.providerID}/${model.modelID}` === assignment.selected)
    assert.ok(selected, `selected model ${assignment.selected} is in the plan`)
    assert.deepEqual(agent.model, {
      providerID: selected.providerID,
      id: selected.modelID,
      ...(selected.variant ? { variant: selected.variant } : {}),
    }, assignment.name)
  }
})

test("unbound agent stays unchanged and eligible pins apply to both test agents", async () => {
  const { config, agentIDs } = await fixtureConfig()
  const agent = { id: "unbound-agent", model: { providerID: "host", id: "original" } }
  const eligibility = new Map<string, ModelEligibility>(
    config.plans["test-agent"].map((model) => [modelKey(model), { status: "available" }]),
  )

  applyAgentRouting(editorFor(agent), config, config.plans["test-agent"], eligibility, 0)
  for (const agentID of agentIDs) {
    const boundAgent = { id: agentID, model: undefined as unknown }
    applyAgentRouting(
      editorFor(boundAgent), config, config.plans["test-agent"], eligibility, 0,
      new Map([[agentID, config.plans["test-agent"][1]]]),
    )
    assert.deepEqual(boundAgent.model, { providerID: "fixture", id: "backup-model" })
  }

  assert.deepEqual(agent.model, { providerID: "host", id: "original" })
})
