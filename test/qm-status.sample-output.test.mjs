import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { registerAgentRouting } from "../src/agent-routing.ts"
import { parseConfig } from "../src/config.ts"
import { LocalHealth } from "../src/local-health.ts"
import { registerQuartermasterRpc } from "../src/rpc.ts"

test("print sample qm-status report for documentation", async () => {
  const projectID = "fixture-project"
  const sessionID = "fixture-session"
  const config = parseConfig({
    plans: { "test-agent": ["ninfer/qwen3.8-27b", "opencode/space-bunny-free"] },
    agents: { "qm-test": "test-agent" },
    localEndpoints: { ninfer: "http://127.0.0.1:8080/v1/models" },
  })
  const commands = {}
  let handlers
  const context = {
    app: { name: "opencode", version: "2.0.23", channel: "stable" },
    location: { project: { id: projectID }, directory: "/fixture/project" },
    agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
    model: {
      list: async () => ({
        data: [
          { providerID: "ninfer", id: "qwen3.8-27b", enabled: true },
          { providerID: "opencode", id: "space-bunny-free", enabled: true },
        ],
      }),
    },
    rpc: Object.assign(() => ({}), {
      register: async (_definition, methods) => { handlers = methods; return { dispose: async () => {} } },
    }),
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {} },
    command: {
      transform: async (callback) => {
        callback({ add: (command) => { commands[command.name] = command } })
        return { dispose: async () => {} }
      },
    },
    session: {
      hook: async () => ({ dispose: async () => {} }),
      get: async () => ({
        data: {
          projectID,
          agent: "qm-test",
          model: { providerID: "cursor", id: "composer-2.5", variant: "default" },
        },
      }),
      switchModel: async () => {},
      synthetic: async () => {},
    },
  }
  const probe = mock.method(LocalHealth.prototype, "checkAll", async () => new Map([["ninfer", "offline"]]))
  let routing
  try {
    routing = await registerAgentRouting(context, config)
    await registerQuartermasterRpc(context, config, routing)
    const probes = probe.mock.callCount()
    assert.ok(probes > 0, "bootstrap health must use the mock")
    const rpcReport = await handlers.diagnoseSession({ sessionID }, {})
    await commands["qm-status"].execute({ sessionID })
    console.log("=== quartermaster.diagnoseSession (synthetic offline sample) ===")
    console.log(JSON.stringify(rpcReport, null, 2))
    assert.equal(rpcReport.session.agent, "qm-test")
    assert.equal(rpcReport.session.plan.id, "test-agent")
    assert.equal(rpcReport.session.id, sessionID)
    assert.equal(rpcReport.location.projectID, projectID)
    assert.equal(rpcReport.location.directory, "/fixture/project")
    assert.equal(rpcReport.availability.localHealth.ninfer, "offline")
    assert.equal(probe.mock.callCount(), probes, "diagnostics must not probe")
  } finally {
    await routing?.dispose()
    probe.mock.restore()
  }
})
