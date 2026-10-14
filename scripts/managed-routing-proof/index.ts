import quartermaster from "../../index.js"

// Test-only wrapper. Location ctx sees synthetic quota; the global usage RPC is not registered over.
function limitedSnapshot() {
  const now = new Date().toISOString()
  const resetAt = new Date(Date.now() + 86_400_000).toISOString()
  const source = (limited: boolean) => ({
    authenticated: true,
    checkedAt: now,
    stale: false,
    error: null,
    windows: [{
      name: "qm-synthetic-limited",
      usedPercent: limited ? 100 : 10,
      state: limited ? "rate-limited" : "ok",
      resetsAt: limited ? resetAt : null,
      ...(limited ? { resetEstimated: true } : {}),
    }],
    nextAvailableAt: limited ? resetAt : null,
    availability: limited ? "limited" : "available",
  })
  return {
    schemaVersion: 1,
    updatedAt: now,
    fixture: "synthetic-limited",
    sources: { go: source(true), codex: source(false), cursor: source(false) },
    models: { go: {} },
  }
}

export default {
  id: quartermaster.id,
  async setup(ctx: Parameters<typeof quartermaster.setup>[0]) {
    const rpc = Object.assign((definition: { id?: string }) => {
      const client = ctx.rpc(definition as never)
      if (definition?.id !== "opencode-usage") return client
      return { ...client, status: async () => limitedSnapshot() }
    }, { register: ctx.rpc.register.bind(ctx.rpc) })
    return quartermaster.setup({ ...ctx, rpc })
  },
}
