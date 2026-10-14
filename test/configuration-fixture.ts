import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ConfigEntry } from "@opencode/client"
import { parseProjectConfig, type ConfigurationReader } from "../src/project-options.ts"

// Test-owned files only: production obtains this ordered list from the receiving server.
export const fixtureConfiguration: ConfigurationReader = async (directory) => {
  const sources: ConfigEntry[] = []
  for (const name of ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"]) {
    const path = join(directory, name)
    const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return undefined
    })
    if (text !== undefined) sources.push({ type: "document", path, info: parseProjectConfig(text) } as ConfigEntry)
  }
  return sources
}
