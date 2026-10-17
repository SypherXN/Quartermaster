import { readFile } from "node:fs/promises"
import { join } from "node:path"
import quartermaster from "../../index.js"
import type { Plugin } from "@opencode/plugin"

// Test-only adapter: a client-side switch failure, not a native host rejection.
export default {
  id: quartermaster.id,
  async setup(ctx) {
    let armed = true
    if (!ctx.location.directory) throw Error("Fixture must have a project directory")
    const settings = JSON.parse(await readFile(join(ctx.location.directory, "quartermaster.jsonc"), "utf8")) as { localEndpoints?: Record<string, string> }
    const endpoints = Object.values(settings.localEndpoints ?? {})
    if (endpoints.length !== 1) throw Error("Fixture must have exactly one health endpoint")
    const endpoint = endpoints[0]
    const session = new Proxy(ctx.session, {
      get(target, key) {
        if (key !== "switchModel") return Reflect.get(target, key)
        return async (input: Parameters<typeof ctx.session.switchModel>[0]) => {
          const current = await target.get({ sessionID: input.sessionID })
          const view = (current.data ?? current) as { agent?: string }
          if (armed && view.agent === "qm-managed-broken") {
            armed = false
            const url = new URL("/switch-fault", endpoint)
            if (url.hostname !== "127.0.0.1") throw Error("Fixture must remain loopback-only")
            const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(2_000) })
            if (!response.ok) throw Error("Could not record injected failure")
            throw Error("Injected fixture client switch failure")
          }
          return target.switchModel(input)
        }
      },
    })
    return quartermaster.setup({ ...ctx, session })
  },
} satisfies Plugin.Plugin
