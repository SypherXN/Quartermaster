import type { Context } from "@opencode/plugin/promise/plugin"
import { TokenLedger } from "./ledger.ts"
import { projectTokenEvents } from "./types.ts"

type CollectorContext = Pick<Context, "event" | "storage"> & {
  session: Pick<Context["session"], "get" | "context">
}

export function startTokenCollector(
  ctx: CollectorContext,
  ledger = new TokenLedger(ctx.storage),
  onRecord?: () => Promise<void>,
) {
  const controller = new AbortController()
  const task = (async () => {
    try {
      await consumeTokenEvents(ctx, ledger, ctx.event.subscribe({ signal: controller.signal }), controller.signal, onRecord)
    } catch {
      if (!controller.signal.aborted) console.warn("[quartermaster] token event subscription failed")
    }
  })()
  return {
    dispose: async () => {
      controller.abort()
      await task
    },
  }
}

export async function consumeTokenEvents(
  ctx: CollectorContext,
  ledger: TokenLedger,
  events: AsyncIterable<unknown>,
  signal: AbortSignal,
  onRecord?: () => Promise<void>,
): Promise<void> {
  try {
    for await (const event of events) {
      if (signal.aborted) return
      const candidate = projectTokenEvents([event])[0]
      if (!candidate) continue

      let context: { projectID?: string; parentSessionID?: string } | undefined
      try {
        const session = await ctx.session.get({ sessionID: candidate.hostSessionID })
        context = { projectID: session.projectID, parentSessionID: session.parentID }
      } catch {
        // Keep the terminal usage record, but leave project attribution unknown.
      }

      let agentID: string | undefined
      try {
        const messages = await ctx.session.context({ sessionID: candidate.hostSessionID })
        const message = messages.find((item) => item.type === "assistant" && item.id === candidate.hostMessageID)
        if (message?.type === "assistant" && typeof message.agent === "string" && message.agent.length > 0) {
          agentID = message.agent
        }
      } catch {
        // Keep usage if the exact terminal assistant message is unavailable.
      }

      const record = projectTokenEvents([event], () => ({ ...context, agentID }))[0]
      if (!record) continue
      try {
        await ledger.ingest(record)
      } catch {
        // A host event may be redelivered; its stable ID makes retry idempotent.
        try {
          await ledger.ingest(record)
        } catch {
          console.warn("[quartermaster] token ledger write failed")
          continue
        }
      }
      try {
        await onRecord?.()
      } catch {
        console.warn("[quartermaster] token budget refresh failed")
      }
    }
  } catch {
    if (!signal.aborted) console.warn("[quartermaster] token event stream stopped")
  }
}
