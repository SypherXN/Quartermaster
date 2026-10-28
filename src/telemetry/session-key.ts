import { createHash } from "node:crypto"

// Same 12 hex chars the session report publishes. Compaction rows store this
// hash so a later cache write can be joined to that session without keeping
// the raw session id.
export function sessionKey(sessionID: string): string {
  return createHash("sha256").update(sessionID).digest("hex").slice(0, 12)
}
