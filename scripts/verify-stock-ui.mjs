import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"

// Stock UI in an owned browser/profile: no credentials, text input or Enter.
const input = process.argv[2]
assert.ok(input, "Pass a successful routing tail-proof.json")
const routing = JSON.parse(await readFile(input, "utf8"))
assert.equal(routing.passed, true)
assert.equal(routing.cleanup, true)
const origin = process.argv[3] ?? "http://127.0.0.1:57123"
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/)
let latestSettings
const settingsHash = async () => {
  const response = await fetch(`${origin}/api/config/settings?surface=web`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(response.status, 200)
  latestSettings = await response.json()
  return createHash("sha256").update(JSON.stringify(latestSettings)).digest("hex")
}
const initialSettingsHash = await settingsHash()
const initialSettings = latestSettings
assert.ok(Array.isArray(initialSettings.recentModels))
assert.ok(Array.isArray(initialSettings.recentAgents))
const fixtureProviders = new Set([routing.fixture.providers.initial, routing.fixture.providers.selected])
for (const provider of fixtureProviders) assert.match(provider ?? "", /^qm-fixture-qm-managed-/)
const host = process.env.OPENCODE_PERMISSION_REVIEWER_HOST_URL
assert.match(host ?? "", /^http:\/\/127\.0\.0\.1:\d+$/)
const nativeSession = async () => {
  const path = `/api/session/${routing.retry.id}?${new URLSearchParams({ "location[directory]": dirname(input) })}`
  const { stdout } = await promisify(execFile)(join(process.env.USERPROFILE, ".opencode/bin/opencode.exe"),
    ["api", "--server", host, "get", path], { timeout: 30_000, windowsHide: true })
  const response = JSON.parse(stdout)
  const value = response.data ?? response
  return { id: value.id, agent: value.agent, model: value.model }
}
const initialSession = await nativeSession()
assert.equal(initialSession.agent, "qm-managed-recover")
let executable
for (const candidate of [
  join(process.env.ProgramFiles ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe"),
  join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
]) {
  try { await access(candidate); executable = candidate; break } catch {}
}
assert.ok(executable, "Use an installed Chromium browser; no downloads")
const directory = await mkdtemp(join(dirname(input), "ui-proof-"))
const profile = join(directory, "browser-profile")
const proof = { passed: false, directory, executable, routingArtifact: input,
  pages: {}, keyboard: [], mutations: [], uiLimitations: [], initialSession, cleanup: false }
let socket, sequence = 0
const pending = new Map()
// Navigation values stay in memory; do not serialize settings or request bodies.
const ownNavigation = {}
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 10_000)
  pending.set(id, { resolve, reject, timer })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const capture = async (label) => {
  await until(() => evaluate("document.getAnimations().filter(a => a instanceof CSSTransition && a.playState === 'running').length"),
    (count) => count === 0, "stock UI transitions settled")
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
  const image = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })
  const path = join(directory, `${label}.png`)
  await writeFile(path, Buffer.from(image.data, "base64"))
  return path
}
const browser = spawn(executable, ["--headless", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "about:blank"], { windowsHide: true, stdio: "ignore" })
proof.browserPID = browser.pid
const exited = new Promise((resolve) => browser.once("exit", resolve))
const until = async (read, check, label) => {
  for (let i = 0; i < 120; i++) {
    const value = await read()
    if (check(value)) return value
    if (browser.exitCode !== null) throw Error("Owned browser exited")
    await delay(250)
  }
  throw Error(`Timed out: ${label}`)
}
try {
  const port = await until(async () => {
    try { return (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0] }
    catch { return null }
  }, Boolean, "owned debugging port")
  assert.match(port, /^\d+$/)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  const target = targets.find((row) => row.type === "page" && row.url === "about:blank")
  assert.ok(target)
  assert.match(target.webSocketDebuggerUrl, /^ws:\/\/127\.0\.0\.1:/)
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === "Network.requestWillBeSent") {
      const { method, url } = message.params.request
      if (url.startsWith(origin) && !["GET", "HEAD", "OPTIONS"].includes(method)) {
        const parsed = new URL(url)
        const sessionMutation = /\/(?:session|sessions)(?:\/|$)/.test(parsed.pathname)
        if (sessionMutation) proof.mutations.push({ method, url })
        if (method === "PUT" && parsed.pathname === "/api/config/settings" && parsed.searchParams.get("surface") === "web") {
          try {
            const changes = JSON.parse(message.params.request.postData ?? "{}")
            for (const key of ["lastDirectory", "activeProjectId"]) {
              if (typeof changes[key] === "string") ownNavigation[key] = changes[key]
            }
          } catch {}
        }
      }
    }
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id); clearTimeout(item.timer)
    if (message.error) item.reject(Error(JSON.stringify(message.error)))
    else item.resolve(message.result)
  }
  await call("Page.enable")
  await call("Network.enable")
  await call("Page.bringToFront")
  proof.browserVersion = await call("Browser.getVersion")
  const metrics = (mobile) => call("Emulation.setDeviceMetricsOverride", {
    width: mobile ? 390 : 1440, height: mobile ? 844 : 900,
    deviceScaleFactor: 1, mobile,
  })
  const page = async (label, id, expected) => {
    assert.match(id, /^ses_[A-Za-z0-9]+$/)
    await call("Page.navigate", { url: `${origin}/?session=${id}` })
    const text = await until(() => evaluate("document.body.innerText"),
      (value) => expected.every((item) => value.toLowerCase().includes(item.toLowerCase())), label)
    const readiness = await until(() => evaluate(`({
      splash: Boolean(document.getElementById('initial-loading')),
      logo: Array.from(document.querySelectorAll('svg')).some(e => {
        const r = e.getBoundingClientRect();
        return e.getAttribute('viewBox') === '0 0 100 100' && r.width >= 80 && r.height >= 80 &&
          e.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      }),
      skeleton: Array.from(document.querySelectorAll('[data-chat-hydration-skeleton]')).some(e =>
        e.checkVisibility({ opacityProperty: true, visibilityProperty: true })),
      composerLoading: document.body.innerText.includes('Loading...')
    })`), (value) => !value.splash && !value.logo && !value.skeleton && !value.composerLoading,
      `${label} painted content and composer ready`)
    const viewport = await evaluate("({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth })")
    const rows = await evaluate(`Array.from(document.querySelectorAll('p')).filter(e => /^qm-managed-/.test(e.innerText)).map(e => {
      const turn = e.closest('section[data-turn-id]');
      return { marker:e.innerText, turnID:turn?.dataset.turnId, text:turn?.innerText };
    })`)
    proof.pages[label] = { id, text, viewport, rows, readiness, screenshot: await capture(label) }
    const sends = id === routing.controls.id ? routing.controls.sends
      : id === routing.retry.id ? [routing.retry.admission, routing.retry.fallback] : []
    for (const send of sends) {
      const row = rows.find((value) => value.marker === send.marker)
      const model = send.session.model.id
      assert.ok(["selected", "composer"].includes(model))
      assert.equal(send.requests.at(-1).model, model)
      const variant = send.requests.at(-1).variant
      const servingVariant = send.session.model.variant === "default" ? null : send.session.model.variant ?? null
      assert.equal(servingVariant, variant ?? null)
      assert.ok(row?.turnID, `Missing stock UI turn: ${send.marker}`)
      assert.match(row.text, new RegExp(`\\n${model}\\n(?:·|$)`, "i"), `UI completion model: ${send.marker}`)
      if (variant && !new RegExp(`\\n${variant}\\n(?:·|$)`, "i").test(row.text)) {
        proof.uiLimitations.push(`${send.marker}: the stock UI omits the ${variant} variant label for this temporary provider; native session and wire variants agree.`)
      }
    }
  }
  await metrics(false)
  await page("retry-desktop", routing.retry.id,
    ["qm-managed-retry-admission", "qm-managed-retry", "selected", "composer", "OK"])
  await page("controls-desktop", routing.controls.id,
    ["qm-managed-admission", "qm-managed-repeat", "qm-managed-manual", "qm-managed-manual-repeat", "qm-managed-resume", "selected", "composer"])
  proof.uiLimitations.push("The failed 429 attempt has no separate completed-message row; the wire trace establishes that attempt independently of the successful fallback label.")
  await page("partial-desktop", routing.partial.id, ["PARTIAL", "tool-proof.txt", "selected", "OK"])
  await page("exhaustion-desktop", routing.exhaustion.id, ["qm-managed-exhaust"])
  await page("keyboard-desktop", routing.retry.id, ["qm-managed-retry-admission", "composer"])
  const focused = () => evaluate(`(() => {
    const e = document.activeElement, r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return { tag: e.tagName, label: e.getAttribute('aria-label') || e.innerText?.slice(0,100),
      placeholder: e.getAttribute('placeholder'),
      editable: e.isContentEditable, role: e.getAttribute('role'), focusVisible: e.matches(':focus-visible'),
      outline: s.outline, shadow: s.boxShadow, x: r.x, y: r.y, width: r.width, height: r.height };
  })()`)
  const key = async (name = "Tab", code = "Tab", virtual = 9, modifiers = 0) => {
    for (const type of ["rawKeyDown", "keyUp"]) await call("Input.dispatchKeyEvent", {
      type, key: name, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual, modifiers,
    })
    await evaluate("new Promise(resolve => requestAnimationFrame(resolve))")
    return focused()
  }
  // Stock composer consumes Tab for agent cycling. Use its native picker shortcut.
  const keyboardCase = async (kind, focus, expected) => {
    if (!expected(focus)) focus = await until(focused, expected, `keyboard focus: ${kind}`)
    proof.keyboard.push({ kind, focus })
    proof.pages[`focus-${kind}`] = { focus, text: await evaluate("document.body.innerText"), screenshot: await capture(`focus-${kind}`) }
    assert.equal(focus.focusVisible, true)
    assert.ok(expected(focus), `Keyboard must reach ${kind}`)
  }
  await keyboardCase("model", await key("M", "KeyM", 77, 10),
    (focus) => /model/i.test(focus.placeholder ?? focus.label ?? ""))
  let composer = await key("Escape", "Escape", 27)
  for (let i = 0; i < 20 && !composer.editable && composer.role !== "textbox"; i++) composer = await key("Tab", "Tab", 9, 8)
  await keyboardCase("composer", composer,
    (focus) => focus.editable || focus.role === "textbox")
  const draftAgent = () => evaluate(`document.body.innerText.split('\\n').map(text=>text.trim()).filter(text=>/^(qm-managed-[\\w-]+|Build|Plan|orchestrator)$/i.test(text)).at(-1)`)
  const beforeAgent = await draftAgent()
  assert.ok(beforeAgent, "The private draft agent must be observable")
  await keyboardCase("agent-cycle", await key(),
    (focus) => focus.editable || focus.role === "textbox")
  const afterAgent = await draftAgent()
  assert.ok(afterAgent, "The cycled private draft agent must be observable")
  assert.notEqual(afterAgent, beforeAgent, "Tab must cycle the private browser's draft agent")
  await keyboardCase("reverse-agent-cycle", await key("Tab", "Tab", 9, 8),
    (focus) => focus.editable || focus.role === "textbox")
  const reverseAgent = await draftAgent()
  assert.ok(reverseAgent, "The reverse-cycled private draft agent must be observable")
  assert.notEqual(reverseAgent, afterAgent, "Shift+Tab must reverse draft agent cycling")
  proof.draftAgentCycle = { beforeAgent, afterAgent, reverseAgent }
  await metrics(true)
  await call("Emulation.setUserAgentOverride", {
    userAgent: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
  })
  await call("Emulation.setTouchEmulationEnabled", { enabled: true })
  await page("retry-mobile", routing.retry.id, ["qm-managed-retry-admission", "selected", "composer", "OK"])
  assert.equal(proof.pages["retry-mobile"].viewport.width, 390)
  assert.ok(proof.pages["retry-mobile"].viewport.scrollWidth <= 390, "No horizontal page overflow")
  assert.equal(proof.mutations.length, 0, "No prompts or session-selection mutations during inspection")
  proof.finalSession = await nativeSession()
  assert.deepEqual(proof.finalSession, initialSession, "No native session model/agent changes")
  proof.casesPassed = true
} catch (error) {
  proof.error = String(error)
  console.error(`UI proof: ${directory}`)
  if (socket?.readyState === WebSocket.OPEN) {
    proof.loadingElements = await evaluate(`Array.from(document.querySelectorAll('svg')).filter(e => e.getBoundingClientRect().width >= 80).map(e => ({
      viewBox:e.getAttribute('viewBox'), label:e.getAttribute('aria-label'), parentClass:e.parentElement.className,
      grandparents:[e.parentElement.parentElement?.className, e.parentElement.parentElement?.parentElement?.className]
    }))`).catch(() => null)
    proof.failureText = await evaluate("document.body.innerText").catch(() => null)
    proof.failureScreenshot = await capture("failure").catch(() => null)
  }
  throw error
} finally {
  if (socket?.readyState === WebSocket.OPEN) await call("Browser.close").catch(() => {})
  socket?.close()
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Browser closing")) }
  if (browser.exitCode === null) browser.kill()
  await exited
  proof.cleanup = true
  try {
    await settingsHash()
    const current = latestSettings
    const changes = {}
    const normalized = (value) => value.replaceAll("\\", "/").toLowerCase()
    if (typeof current.lastDirectory === "string" && normalized(current.lastDirectory) === normalized(dirname(input))) {
      assert.equal(typeof initialSettings.lastDirectory, "string")
      changes.lastDirectory = initialSettings.lastDirectory
    }
    for (const key of ["lastDirectory", "activeProjectId"]) {
      if (typeof initialSettings[key] === "string" && current[key] === ownNavigation[key] && current[key] !== initialSettings[key]) {
        changes[key] = initialSettings[key]
      }
    }
    assert.ok(Array.isArray(current.recentModels))
    const key = (entry) => JSON.stringify([entry.providerID, entry.modelID])
    const recent = current.recentModels.filter((entry) => !fixtureProviders.has(entry.providerID))
    const present = new Set(recent.map(key))
    // Preserve concurrent user history; restore baseline entries evicted by fixture recency.
    const baselineRecent = initialSettings.recentModels.filter((entry) => !fixtureProviders.has(entry.providerID))
    const restored = JSON.stringify(recent) === JSON.stringify(baselineRecent)
      ? initialSettings.recentModels
      : [...recent, ...initialSettings.recentModels.filter((entry) => !present.has(key(entry)))]
    if (JSON.stringify(restored) !== JSON.stringify(current.recentModels)) changes.recentModels = restored
    assert.ok(Array.isArray(current.recentAgents))
    const agents = current.recentAgents.filter((name) => !["qm-managed-recover", "qm-managed-test"].includes(name))
    const baselineAgents = initialSettings.recentAgents.filter((name) => !["qm-managed-recover", "qm-managed-test"].includes(name))
    const restoredAgents = JSON.stringify(agents) === JSON.stringify(baselineAgents)
      ? initialSettings.recentAgents
      : [...agents, ...initialSettings.recentAgents.filter((name) => !agents.includes(name))]
    if (JSON.stringify(restoredAgents) !== JSON.stringify(current.recentAgents)) changes.recentAgents = restoredAgents
    const fixtureEffort = (key) => [...fixtureProviders].some((provider) => key.startsWith(`${provider}/`))
    const efforts = { ...current.recentEfforts }
    for (const key of new Set([...Object.keys(efforts), ...Object.keys(initialSettings.recentEfforts ?? {})])) {
      if (!fixtureEffort(key)) continue
      if (Object.hasOwn(initialSettings.recentEfforts ?? {}, key)) efforts[key] = initialSettings.recentEfforts[key]
      else delete efforts[key]
    }
    if (JSON.stringify(efforts) !== JSON.stringify(current.recentEfforts)) changes.recentEfforts = efforts
    proof.restoredHistoryKeys = Object.keys(changes)
    if (proof.restoredHistoryKeys.length) {
      const response = await fetch(`${origin}/api/config/settings?surface=web`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes), signal: AbortSignal.timeout(5_000),
      })
      assert.equal(response.status, 200, "Restore only task-owned UI history")
    }
  } catch (error) {
    proof.cleanupError = String(error)
  }
  proof.settingsUnchanged = (await settingsHash()) === initialSettingsHash
  const before = initialSettings.settings ?? initialSettings
  const after = latestSettings.settings ?? latestSettings
  proof.settingsChangedKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
  proof.passed = Boolean(proof.casesPassed && proof.settingsUnchanged && !proof.cleanupError)
  await writeFile(join(directory, "ui-proof.json"), JSON.stringify(proof, null, 2))
}
assert.equal(proof.cleanupError, undefined, proof.cleanupError)
assert.equal(proof.settingsUnchanged, true, "Preferences unchanged after owned browser cleanup")
console.log(JSON.stringify({ passed: proof.passed, directory, cleanup: proof.cleanup }, null, 2))
