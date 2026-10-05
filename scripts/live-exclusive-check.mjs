import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"

const password = "qm-live-test"
const port = 41237
const directory = "C:\\Users\\mattg\\AppData\\Local\\Temp\\qm-exclusive-live"
const opencode = "C:\\Users\\mattg\\.opencode\\bin\\opencode.exe"
const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
const child = spawn(opencode, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
  cwd: directory,
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
  windowsHide: true,
})
let log = ""
child.stdout.on("data", (chunk) => { log += chunk })
child.stderr.on("data", (chunk) => { log += chunk })

const stop = () => { if (!child.killed) child.kill() }
process.on("exit", stop)

async function api(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text }
}

function models(payload) {
  const data = JSON.parse(payload).data ?? JSON.parse(payload)
  const list = Array.isArray(data) ? data : data.data ?? []
  return list.filter((agent) => agent.id === "holder" || agent.id === "waiter").map((agent) => ({
    id: agent.id,
    model: agent.model ?? null,
  }))
}

try {
  let ready
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      ready = await api("GET", "/api/agent")
      if (ready.status !== 401) break
    } catch {
      ready = undefined
    }
    await delay(500)
  }
  if (!ready || ready.status !== 200) {
    console.log(JSON.stringify({ stage: "agent-list", status: ready?.status ?? "down", log: log.slice(-2000) }, null, 2))
    process.exitCode = 1
  } else {
    const before = models(ready.text)
    const created = await api("POST", "/api/session", {})
    const session = JSON.parse(created.text)
    const sessionID = session.id ?? session.data?.id
    const switched = await api("POST", `/api/session/${sessionID}/agent`, { agent: "holder" })
    const prompt = api("POST", `/api/session/${sessionID}/prompt`, {
      text: "Write four sentences about rivers. Do not use tools.",
    })
    let during = before
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(500)
      const snapshot = await api("GET", "/api/agent")
      if (snapshot.status !== 200) continue
      during = models(snapshot.text)
      const waiter = during.find((agent) => agent.id === "waiter")
      if (waiter?.model && waiter.model.providerID !== "ninfer") break
    }
    const holderTurn = await Promise.race([
      prompt.then((result) => ({ status: result.status, done: true })),
      delay(20000).then(() => ({ status: "still-running", done: false })),
    ])
    console.log(JSON.stringify({ before, during, sessionStatus: created.status, sessionID, switchStatus: switched.status, holderTurn }, null, 2))
  }
} finally {
  stop()
}
