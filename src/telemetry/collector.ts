import type { Context } from "@opencode/plugin/promise/plugin"
import { CompactionLedger, projectCompactionEvent } from "./compaction.ts"
import { TokenLedger } from "./ledger.ts"
import { StepModelClaims } from "./step-model.ts"
import { projectTokenEvents } from "./types.ts"
import { projectWindow, windowHasText, WindowLedger } from "./window.ts"

type CollectorContext = Pick<Context, "event" | "storage"> & {
  session: Pick<Context["session"], "get" | "context">
}

export function startTokenCollector(
  ctx: CollectorContext,
  ledger = new TokenLedger(ctx.storage),
  onRecord?: () => Promise<void>,
  compactionLedger = new CompactionLedger(ctx.storage),
  windowLedger = new WindowLedger(ctx.storage),
  fallbackProjectID?: string,
) {
  const controller = new AbortController()
  const task = (async () => {
    try {
      await consumeTokenEvents(ctx, ledger, ctx.event.subscribe({ signal: controller.signal }), controller.signal, onRecord, compactionLedger, windowLedger, new StepModelClaims(), fallbackProjectID)
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
  compactionLedger?: CompactionLedger,
  windowLedger?: WindowLedger,
  claims = new StepModelClaims(),
  fallbackProjectID?: string,
): Promise<void> {
  try {
    for await (const event of events) {
      if (signal.aborted) return
      claims.observe(event)
      const compaction = projectCompactionEvent(event)
      if (compaction && compactionLedger) {
        let compactionProject: string | null = fallbackProjectID ?? null
        try {
          compactionProject = (await ctx.session.get({ sessionID: compaction.sessionID })).projectID ?? compactionProject
        } catch {
          // Keep the compaction call, but fall back to this instance's project.
        }
        const { sessionID: _sessionID, ...stored } = compaction
        try {
          await compactionLedger.ingest({ ...stored, projectID: compactionProject })
        } catch {
          console.warn("[quartermaster] compaction ledger write failed")
        }
      }
      const candidate = projectTokenEvents([event])[0]
      if (!candidate) continue

      // Every row is bound to a project: when the host has not resolved one for the
      // session yet, this instance's own project is the correct owner.
      let context: { projectID?: string; parentSessionID?: string } | undefined =
        fallbackProjectID === undefined ? undefined : { projectID: fallbackProjectID }
      try {
        const session = await ctx.session.get({ sessionID: candidate.hostSessionID })
        context = { projectID: session.projectID ?? fallbackProjectID, parentSessionID: session.parentID }
      } catch {
        // Keep the terminal usage record under this instance's project.
      }

      let agentID: string | undefined
      let messageModel: { providerID: string; modelID: string; variant: string | null } | undefined
      let messages: readonly unknown[] | undefined
      try {
        const contextMessages = await ctx.session.context({ sessionID: candidate.hostSessionID })
        messages = contextMessages
        const message = contextMessages.find((item) => item.type === "assistant" && item.id === candidate.hostMessageID)
        if (message?.type === "assistant") {
          if (typeof message.agent === "string" && message.agent.length > 0) {
            agentID = message.agent
          }
          // The assistant message names its own model, which is the fallback for a
          // step whose session.step.started this instance never saw.
          const providerID = message.model?.providerID
          const modelID = message.model?.id
          if (typeof providerID === "string" && providerID.length > 0 && typeof modelID === "string" && modelID.length > 0) {
            const variant = message.model?.variant
            messageModel = { providerID, modelID, variant: typeof variant === "string" && variant.length > 0 ? variant : null }
          }
        }
      } catch {
        // Keep usage if the exact terminal assistant message is unavailable.
      }
      if (windowLedger && messages) {
        const counts = projectWindow(messages)
        if (windowHasText(counts)) {
          try {
            await windowLedger.ingest({
              projectID: context?.projectID ?? null,
              sessionID: candidate.hostSessionID,
              observedAt: candidate.completedAt,
              ...counts,
            })
          } catch {
            console.warn("[quartermaster] window ledger write failed")
          }
        }
      }

      // Pair the step with its own start event; when that was missed (the plugin
      // subscribed mid-step) the host message still names the model.
      const model = claims.claim(candidate.hostEventID, candidate.hostMessageID) ?? messageModel
      const record = projectTokenEvents([event], () => ({
        ...context,
        agentID,
        ...(model ? { model: { providerID: model.providerID, modelID: model.modelID, ...(model.variant === null ? {} : { variant: model.variant }) } } : {}),
      }))[0]
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
