import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import type { QuartermasterReport } from "./report.ts"

// Deliberate allowlist: never serialize the report wholesale (rates, session
// identifiers, configuration and future fields do not belong in an offline file).
const counters = ["records", "observedTokens", "unknownTokenRecords", "partialTokenRecords",
  "partialRecords", "input", "output", "reasoning", "cacheRead", "cacheWrite",
  "unknownCacheRecords", "cacheHitRate", "hostCostUSD", "hostCostMissing"] as const
function counts(value: object) {
  return Object.fromEntries(counters.flatMap((key) => {
    const item = (value as Record<string, unknown>)[key]
    return item === null || (typeof item === "number" && Number.isFinite(item)) ? [[key, item]] : []
  }))
}

export function cachedReport(report: QuartermasterReport) {
  return {
    schemaVersion: 1, status: "partial", generatedAt: report.generatedAt, projectID: report.projectID,
    // This is a saved observation, never a claim that the host is currently live.
    source: "cached-event-ledger", complete: false,
    range: { since: report.range.since, until: report.range.until },
    totals: counts(report.totals), archived: counts(report.archived),
    agents: report.agentAttribution.dimensions.items.map((row) => ({ agentID: row.agentID, ...counts(row) })),
    directUsage: { ...counts(report.directUsage), items: report.directUsage.dimensions.items.map((row) => ({
      pluginID: row.pluginID, providerID: row.providerID, modelID: row.modelID, variant: row.variant, ...counts(row),
    })) },
    costs: {
      status: report.costs.status, unpricedTokens: report.costs.unpricedTokens,
      unpricedTokenPercentage: report.costs.unpricedTokenPercentage,
      unknownTokenRecords: report.costs.unknownTokenRecords,
      currencies: report.costs.currencies.map((row) => ({ currency: row.currency,
        estimatedAmount: row.estimatedAmount, estimatedCacheReadSavings: row.estimatedCacheReadSavings,
        cacheSavingsRecords: row.cacheSavingsRecords })),
    },
    pagination: { agents: report.agentAttribution.dimensions.nextOffset,
      directUsage: report.directUsage.dimensions.nextOffset },
  }
}

export async function writeReportCache(path: string, report: QuartermasterReport) {
  const target = resolve(path)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(cachedReport(report)) + "\n", { mode: 0o600, flag: "wx" })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw new Error("Usage: npm run report:cached -- <cache-file>")
    const snapshot = JSON.parse(await readFile(resolve(process.argv[2]), "utf8"))
    if (snapshot.schemaVersion !== 1 || snapshot.source !== "cached-event-ledger") throw new Error("Invalid report cache")
    console.log(JSON.stringify(snapshot, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Report cache unavailable")
    process.exitCode = 1
  }
}
