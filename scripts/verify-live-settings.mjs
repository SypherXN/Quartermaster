// Parses the live Quartermaster settings with the plugin's own loader and prints the
// resolved settings. Usage: node scripts/verify-live-settings.mjs [path-to-quartermaster.jsonc]
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseProjectConfig } from "../dist/project-options.js"
import { parseConfig } from "../dist/config.js"

const file = process.argv[2] ?? join(homedir(), ".config", "opencode", "quartermaster.jsonc")
const text = readFileSync(file, "utf8")
const config = parseConfig(parseProjectConfig(text))

const planModels = new Set()
for (const plan of Object.values(config.plans ?? {})) {
  for (const model of Array.isArray(plan) ? plan : []) {
    if (model && model.providerID) planModels.add(`${model.providerID}/${model.modelID}`)
  }
}

console.log(
  JSON.stringify(
    {
      file,
      probeRateLimits: config.probeRateLimits,
      probeIntervalMs: config.probeIntervalMs,
      probeMaxBackoffMs: config.probeMaxBackoffMs,
      providerCooldownMs: config.providerCooldownMs,
      sharedRateLimits: config.sharedRateLimits,
      planModels: [...planModels].sort(),
    },
    null,
    2,
  ),
)
