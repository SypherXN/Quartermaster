import { Plugin } from "@opencode/plugin"
import { registerAgentRouting } from "./agent-routing.ts"
import { parseConfig } from "./config.ts"
import { readUsageStatus, type UsageReadResult } from "./usage.ts"
import { registerQuartermasterRpc } from "./rpc.ts"

export default Plugin.define({
  id: "quartermaster",
  async setup(ctx) {
    const config = parseConfig(ctx.options)
    let usage: UsageReadResult | undefined
    if (Object.keys(config.usageSources).length > 0) {
      usage = await readUsageStatus(ctx)
      if (usage.status === "unavailable") {
        console.warn(`[quartermaster] opencode-usage status unavailable: ${usage.reason}`)
      }
    }
    const routing = await registerAgentRouting(ctx, config, usage)
    try {
      const rpc = await registerQuartermasterRpc(ctx, config, routing, usage)
      return async () => {
        await rpc.dispose()
        await routing?.dispose()
      }
    } catch (error) {
      await routing?.dispose()
      throw error
    }
  },
})
