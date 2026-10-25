import { copyFile, lstat, mkdir, readFile, realpath, rm, rmdir, stat, writeFile as writeFileDefault } from "node:fs/promises"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode, type ConfigEntry } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { parseConfig, type QuartermasterConfig } from "./config.ts"

export type ConfigurationReader = (directory: string) => Promise<readonly ConfigEntry[]>

/** The configuration could not be read or resolved. Distinct from invalid configuration content. */
export class ProjectConfigurationUnresolved extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProjectConfigurationUnresolved"
  }
}

const provenanceUnavailable = () => new ProjectConfigurationUnresolved("Receiving server configuration provenance is unavailable")

type ServerEndpoint = {
  url: string
  auth?: { type: "basic"; username: string; password: string }
}

type ProcessListen = {
  argv: readonly string[]
  env: NodeJS.ProcessEnv
}

const loopbackServer = (endpoint: ServerEndpoint) => {
  let url: URL
  try {
    url = new URL(endpoint.url)
  } catch {
    return false
  }
  return (url.protocol === "http:" || url.protocol === "https:")
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    && !url.username
    && !url.password
}

// Identity must be this process. Another server's documents are not configuration provenance.
const readVerifiedConfiguration = async (endpoint: ServerEndpoint, directory: string, signal: AbortSignal) => {
  if (!loopbackServer(endpoint)) return undefined
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  const info = await client.server.info({ signal }).catch(() => undefined)
  if (!info || typeof info.pid !== "number") return undefined
  if (info.pid !== process.pid) return { mismatch: true as const }
  return client.config.get({ location: { directory } }, { signal })
}

const matchedConfiguration = (verified: Awaited<ReturnType<typeof readVerifiedConfiguration>>) =>
  Array.isArray(verified) ? verified : undefined

const flagValue = (args: readonly string[], name: string) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

// `serve --service` is the only process Service.discover() can return. The receiving project server is separate.
const receivingProcessEndpoint = (listen: ProcessListen): ServerEndpoint | undefined => {
  if (!listen.argv.includes("serve")) return undefined
  const port = flagValue(listen.argv, "--port")
  if (!port || !/^[0-9]+$/.test(port)) return undefined
  const portNumber = Number(port)
  if (!Number.isSafeInteger(portNumber) || portNumber < 1 || portNumber > 65535) return undefined
  const hostname = flagValue(listen.argv, "--hostname") ?? "127.0.0.1"
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1" && hostname !== "[::1]") return undefined
  const host = hostname === "::1" ? "[::1]" : hostname
  return { url: `http://${host}:${port}` }
}

const basicAuth = (username: string, password: string): NonNullable<ServerEndpoint["auth"]> =>
  ({ type: "basic", username, password })

const sameAuth = (left: ServerEndpoint["auth"], right: ServerEndpoint["auth"]) =>
  left?.username === right?.username && left?.password === right?.password

// The receiving process password is its own credential. The background service password and an open loopback server are only fallbacks.
const authCandidates = (listen: ProcessListen, discovered?: ServerEndpoint) => {
  const auths: Array<ServerEndpoint["auth"]> = []
  const push = (auth: ServerEndpoint["auth"]) => {
    if (auths.some((item) => sameAuth(item, auth))) return
    auths.push(auth)
  }
  for (const password of [listen.env.OPENCODE_SERVER_PASSWORD, listen.env.OPENCODE_PASSWORD]) {
    if (password) push(basicAuth("opencode", password))
  }
  if (discovered?.auth) push(discovered.auth)
  push(undefined)
  return auths
}

export async function readNativeConfiguration(directory: string, listen: ProcessListen = { argv: process.argv, env: process.env }): Promise<readonly ConfigEntry[]> {
  const signal = AbortSignal.timeout(2_000)
  const discovered = await Service.discover()
  if (discovered) {
    const config = matchedConfiguration(await readVerifiedConfiguration(discovered, directory, signal))
    if (config) return config
  }
  const own = receivingProcessEndpoint(listen)
  if (own) {
    for (const auth of authCandidates(listen, discovered ?? undefined)) {
      const verified = await readVerifiedConfiguration(auth ? { ...own, auth } : own, directory, signal)
      const config = matchedConfiguration(verified)
      if (config) return config
      if (verified && "mismatch" in verified) break
    }
  }
  throw provenanceUnavailable()
}

const blankComments = (text: string) => {
  let out = ""
  let index = 0
  while (index < text.length) {
    if (text[index] === "\"") {
      const start = index
      index = endString(text, index)
      out += text.slice(start, index)
      continue
    }
    if (text.startsWith("//", index)) {
      const start = index
      while (index < text.length && text[index] !== "\n") index += 1
      out += " ".repeat(index - start)
      continue
    }
    if (text.startsWith("/*", index)) {
      const start = index
      index += 2
      while (index < text.length && !text.startsWith("*/", index)) index += 1
      if (index >= text.length) throw new Error("Project config has an unterminated comment")
      index += 2
      out += " ".repeat(index - start)
      continue
    }
    out += text[index]
    index += 1
  }
  return out
}

export const parseProjectConfig = (text: string) => {
  const blanked = blankComments(text)
  let normalized = ""
  let previous = ""
  for (let index = 0; index < blanked.length; index += 1) {
    if (blanked[index] === "\"") {
      const end = endString(blanked, index)
      normalized += blanked.slice(index, end)
      index = end - 1
      previous = "\""
    } else {
      let next = index + 1
      if (blanked[index] === ",") while (next < blanked.length && " \t\r\n".includes(blanked[next])) next += 1
      normalized += blanked[index] === "," && previous && !"[{,:".includes(previous) && "}]".includes(blanked[next] ?? " ") ? " " : blanked[index]
      if (!" \t\r\n".includes(blanked[index])) previous = blanked[index]
    }
  }
  return JSON.parse(normalized) as unknown
}

const endString = (text: string, index: number) => {
  index += 1
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2
      continue
    }
    if (text[index] === "\"") return index + 1
    index += 1
  }
  throw new Error("Project config has an unterminated string")
}

const insideDirectory = (root: string, path: string) => {
  const suffix = relative(root, path)
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

const missing = (error: NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT") throw error
  return undefined
}

const containedPath = async (root: string, path: string, allowMissing = false) => {
  let resolved = await realpath(path).catch(missing)
  if (resolved === undefined) {
    const info = await lstat(path).catch(missing)
    if (info?.isSymbolicLink()) throw new Error("Project config has an unresolvable link")
    if (!allowMissing) return undefined
    resolved = resolve(await realpath(dirname(path)), basename(path))
  }
  if (!insideDirectory(root, resolved)) throw new Error("Project config resolves outside project directory")
  const info = await lstat(resolved).catch(missing)
  if (info && info.nlink > 1 && !info.isDirectory()) throw new Error("Project config has multiple hard links")
  return resolved
}

const packageSpans = (blanked: string) => {
  const spans: { start: number, end: number, value: string }[] = []
  let index = 0
  const keys: Set<string>[] = []
  let inPlugins = false
  while (index < blanked.length) {
    if (blanked[index] !== "\"") {
      if (blanked[index] === "]" && keys.length === 2) inPlugins = false
      if (blanked[index] === "{" || blanked[index] === "[") keys.push(new Set())
      if (blanked[index] === "}" || blanked[index] === "]") keys.pop()
      index += 1
      continue
    }
    const keyStart = index
    const keyEnd = endString(blanked, index)
    const key = JSON.parse(blanked.slice(keyStart, keyEnd)) as unknown
    index = keyEnd
    while (index < blanked.length && blanked[index] <= " ") index += 1
    if (blanked[index] !== ":") continue
    if (key === "plugins" || key === "options" || key === "package") {
      const seen = keys.at(-1)
      if (seen?.has(key)) throw new Error(`Duplicate "${key}" key in project config`)
      seen?.add(key)
    }
    index += 1
    while (index < blanked.length && blanked[index] <= " ") index += 1
    if (keys.length === 1 && key === "plugins" && blanked[index] === "[") inPlugins = true
    if (!inPlugins || keys.length !== 3 || key !== "package") continue
    if (blanked[index] !== "\"") continue
    const valueStart = index
    const valueEnd = endString(blanked, index)
    const value = JSON.parse(blanked.slice(valueStart, valueEnd)) as unknown
    if (typeof value === "string") spans.push({ start: valueStart, end: valueEnd, value })
    index = valueEnd
  }
  return spans
}

export const QUARTERMASTER_SETTINGS_FILE = "quartermaster.jsonc"
const settingsLocationError = "Quartermaster settings belong in quartermaster.jsonc beside the OpenCode config, not in plugins[].options"

const assertNoInlineSettings = (value: unknown) => {
  if (value == null) return
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Quartermaster plugin entry options must be an object")
  if (Object.keys(value).length > 0) throw new Error(settingsLocationError)
}

const settingsFile = (configPath: string) => resolve(dirname(configPath), QUARTERMASTER_SETTINGS_FILE)

const readSiblingSettings = async (configPath: string) => {
  const configReal = await realpath(configPath)
  const candidate = settingsFile(configReal)
  const resolved = await realpath(candidate).catch(missing)
  if (resolved === undefined) return { path: candidate, text: undefined as string | undefined, options: {} as unknown }
  if (dirname(resolved) !== dirname(configReal)) throw new Error("Quartermaster settings resolve outside the OpenCode config directory")
  const info = await lstat(resolved)
  if (info.nlink > 1 && !info.isDirectory()) throw new Error("Quartermaster settings file has multiple hard links")
  const text = await readFile(resolved, "utf8")
  return { path: resolved, text, options: parseProjectConfig(text) }
}

const samePath = (root: string, path: string) => relative(root, path) === ""

// ponytail: only this running install; another checkout is a different process.
const quartermasterRoot = (() => {
  let pending: Promise<string> | undefined
  return () => pending ??= (async () => {
    let dir = dirname(fileURLToPath(import.meta.url))
    while (true) {
      const text = await readFile(resolve(dir, "package.json"), "utf8").catch(missing)
      if (text !== undefined && packageNames.includes((JSON.parse(text) as { name?: unknown }).name as string)) return realpath(dir)
      const parent = dirname(dir)
      if (parent === dir) throw new Error("Quartermaster package root not found")
      dir = parent
    }
  })()
})()

const localPackageSpec = (value: string) => {
  const spec = value.replaceAll("\\", "/")
  return spec.startsWith("file:") || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/") || /^[A-Za-z]:\//.test(spec)
}

const packageNames = ["opencode-quartermaster", "quartermaster"]
const namedPackage = (value: string) => packageNames.some((name) => value === name || value.startsWith(`${name}@`))

const githubPackage = (value: string) => {
  const spec = value.replace(/#.*$/, "").replace(/\.git$/, "")
  return spec === "github:SypherXN/quartermaster"
    || spec === "https://github.com/SypherXN/quartermaster"
    || spec === "git+https://github.com/SypherXN/quartermaster"
}

const isThisPackage = async (value: string, configFile: string, root: string) => {
  if (!localPackageSpec(value)) return namedPackage(value) || githubPackage(value)
  let target: string
  try {
    target = value.replaceAll("\\", "/").startsWith("file:") ? fileURLToPath(value) : resolve(dirname(configFile), value)
  } catch {
    return false
  }
  const resolved = await realpath(target).catch(missing)
  if (resolved === undefined || !insideDirectory(root, resolved)) return false
  const info = await stat(resolved)
  let dir = info.isDirectory() ? resolved : dirname(resolved)
  while (insideDirectory(root, dir)) {
    const text = await readFile(resolve(dir, "package.json"), "utf8").catch(missing)
    if (text !== undefined) return samePath(root, dir) && packageNames.includes((JSON.parse(text) as { name?: unknown }).name as string)
    if (samePath(root, dir)) return false
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
  return false
}

const effectiveEntry = async (directory: string, readConfiguration: ConfigurationReader) => {
  const root = await realpath(directory)
  const packageRoot = await quartermasterRoot()
  const sources = await readConfiguration(root)
  if (!Array.isArray(sources)) throw new ProjectConfigurationUnresolved("Invalid configuration provenance")
  let selected: { path?: string } | undefined
  for (const source of sources) {
    if (source.type === "directory") continue
    if (source.type !== "document" || !source.info || typeof source.info !== "object")
      throw new ProjectConfigurationUnresolved("Invalid configuration provenance")
    if (source.path && insideDirectory(root, resolve(source.path))) {
      const path = await containedPath(root, source.path)
      if (!path) throw new Error("Project config changed; refusing to overwrite")
      const text = await readFile(path, "utf8")
      parseProjectConfig(text)
      packageSpans(blankComments(text))
    }
    const plugins = source.info.plugins ?? []
    if (!Array.isArray(plugins)) throw new Error("Invalid configuration provenance")
    const matches: unknown[] = []
    for (const plugin of plugins) {
      const spec = typeof plugin === "string" ? plugin : plugin.package
      if (typeof spec !== "string") throw new Error("Invalid configuration provenance")
      if (!source.path && localPackageSpec(spec) && !isAbsolute(spec) && !spec.startsWith("file:"))
        throw new Error("Relative plugin source has no configuration path")
      if (await isThisPackage(spec, source.path ?? resolve(root, "opencode.json"), packageRoot)) {
        assertNoInlineSettings(typeof plugin === "string" ? undefined : plugin.options)
        matches.push(plugin)
      }
    }
    if (matches.length > 1) throw new Error("Expected exactly one Quartermaster plugin entry per configuration document")
    if (matches.length === 1) selected = { path: source.path }
  }
  if (!selected) throw new ProjectConfigurationUnresolved("Expected exactly one project Quartermaster plugin entry")
  if (!selected.path) return { options: {}, config: parseConfig({}), revision: 0, writable: false }
  // Inherited and virtual sources are readable, never writable through a project editor.
  if (!insideDirectory(root, resolve(selected.path))) {
    const settings = await readSiblingSettings(selected.path)
    const config = parseConfig(settings.options)
    const revision = settings.text === undefined ? 0 : createHash("sha256").update(JSON.stringify([settings.path, settings.text])).digest().readUIntBE(0, 6)
    return { path: settings.path, options: settings.options, config, revision, writable: false, text: settings.text, existed: settings.text !== undefined }
  }
  const registrationPath = await containedPath(root, selected.path)
  if (!registrationPath) throw new Error("Project config changed; refusing to overwrite")
  const registration = await readFile(registrationPath, "utf8")
  parseProjectConfig(registration)
  const blanked = blankComments(registration)
  const matches: { start: number, end: number, value: string }[] = []
  for (const span of packageSpans(blanked)) {
    if (await isThisPackage(span.value, registrationPath, packageRoot)) matches.push(span)
  }
  if (matches.length !== 1) throw new ProjectConfigurationUnresolved("Expected exactly one project Quartermaster plugin entry")
  const parsed = parseProjectConfig(registration) as { plugins?: { package?: unknown, options?: unknown }[] }
  const entry = parsed.plugins?.find((plugin) => plugin?.package === matches[0].value)
  if (!entry) throw new Error("Project config changed; refusing to overwrite")
  assertNoInlineSettings(entry.options)
  const path = await containedPath(root, settingsFile(registrationPath), true)
  if (!path) throw new Error("Project config changed; refusing to overwrite")
  const text = await readFile(path, "utf8").catch(missing)
  const options = text === undefined ? {} : parseProjectConfig(text)
  const config = parseConfig(options)
  const revision = createHash("sha256").update(JSON.stringify([root, path, text ?? ""])).digest().readUIntBE(0, 6)
  return { path, registrationPath, text: text ?? "", existed: text !== undefined, options, config, revision, writable: true }
}

export async function applyProjectQuartermasterOptions(input: {
  directory: string
  options: unknown
  revision: number
  signal?: AbortSignal
  readConfiguration?: ConfigurationReader
}, io: { writeFile?: typeof writeFileDefault } = {}) {
  parseConfig(input.options)
  if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  const root = await realpath(input.directory)
  const lock = resolve(root, ".quartermaster-options.lock")
  // ponytail: fail closed after a crash; remove the lock only after all writers stop.
  await mkdir(lock).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Project options update already in progress")
    throw error
  })
  try {
    const readConfiguration = input.readConfiguration ?? readNativeConfiguration
    const target = await effectiveEntry(root, readConfiguration)
    if (!target.writable || !target.path || target.text === undefined)
      throw new Error("Effective Quartermaster options are outside the writable project configuration")
    if (target.revision !== input.revision) throw new Error("Project config changed; refusing to overwrite")
    const next = `${JSON.stringify(input.options, null, 2)}\n`
    const previousText = target.text
    const backup = (await containedPath(root, `${target.path}.quartermaster.bak`, true))!
    if (target.existed && await containedPath(root, target.path) !== target.path) throw new Error("Project config changed; refusing to overwrite")
    if (target.existed) await copyFile(target.path, backup)
    const current = await effectiveEntry(root, readConfiguration)
    if (!current.writable || current.path !== target.path || current.revision !== input.revision)
      throw new Error("Project config changed; refusing to overwrite")
    try {
      if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("The operation was aborted", "AbortError")
      if (await containedPath(root, target.path, true) !== target.path) throw new Error("Project config changed; refusing to overwrite")
      await (io.writeFile ?? writeFileDefault)(target.path, next, input.signal ? { signal: input.signal } : undefined)
      if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("The operation was aborted", "AbortError")
    } catch (error) {
      await containedPath(root, target.path, true).then((found) => {
        if (found === undefined) return
        if (target.existed) return writeFileDefault(found, previousText)
        return rm(found, { force: true })
      }).catch(() => undefined)
      throw error
    }
    return { path: target.path, backup }
  } finally {
    await rmdir(lock)
  }
}

// Gateway-only. The plugin writer above still refuses a winning file outside the project.
export async function applyDiscoveredQuartermasterOptions(input: {
  directory: string
  options: unknown
  revision: number
  signal?: AbortSignal
  readConfiguration?: ConfigurationReader
}, io: { writeFile?: typeof writeFileDefault } = {}) {
  parseConfig(input.options)
  if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  const readConfiguration = input.readConfiguration ?? readNativeConfiguration
  const root = await realpath(input.directory)
  const preview = await effectiveEntry(root, readConfiguration)
  if (preview.writable) return applyProjectQuartermasterOptions({ ...input, readConfiguration }, io)
  if (!preview.path) throw new Error("Effective Quartermaster options have no settings file; refusing to create one")
  const lock = resolve(dirname(preview.path), ".quartermaster-options.lock")
  await mkdir(lock).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Project options update already in progress")
    throw error
  })
  try {
    const target = await effectiveEntry(root, readConfiguration)
    if (target.writable || !target.path || target.path !== preview.path || target.revision !== input.revision)
      throw new Error("Project config changed; refusing to overwrite")
    const parent = await realpath(dirname(target.path))
    const file = await containedPath(parent, target.path, true)
    const backup = await containedPath(parent, `${target.path}.quartermaster.bak`, true)
    if (!file || !backup || basename(file) !== QUARTERMASTER_SETTINGS_FILE || (target.existed && file !== target.path))
      throw new Error("Project config changed; refusing to overwrite")
    const next = `${JSON.stringify(input.options, null, 2)}\n`
    if (target.existed) await copyFile(file, backup)
    const current = await effectiveEntry(root, readConfiguration)
    if (current.writable || current.path !== target.path || current.revision !== input.revision)
      throw new Error("Project config changed; refusing to overwrite")
    try {
      if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("The operation was aborted", "AbortError")
      if (await containedPath(parent, file, true) !== file) throw new Error("Project config changed; refusing to overwrite")
      await (io.writeFile ?? writeFileDefault)(file, next, input.signal ? { signal: input.signal } : undefined)
      if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("The operation was aborted", "AbortError")
    } catch (error) {
      await containedPath(parent, file, true).then((found) => {
        if (found !== file) return
        if (target.existed) return writeFileDefault(found, target.text ?? "")
        return rm(found, { force: true })
      }).catch(() => undefined)
      throw error
    }
    return { path: file, backup }
  } finally {
    await rmdir(lock)
  }
}

const CONFIG_FILENAMES = ["opencode.json", "opencode.jsonc"] as const

const enabledFlag = (value: string | undefined) => value === "1" || value?.toLowerCase() === "true"

const isFile = async (path: string) => (await stat(path).catch(missing))?.isFile() === true

// OpenCode keeps user config under the XDG config directory, including on Windows.
const installedConfigDirectory = (env: NodeJS.ProcessEnv) => {
  if (env.OPENCODE_CONFIG_DIR) return resolve(env.OPENCODE_CONFIG_DIR)
  const home = env.OPENCODE_TEST_HOME || homedir()
  const base = env.XDG_CONFIG_HOME || resolve(home, ".config")
  return resolve(base, "opencode")
}

const filesIn = async (dir: string, nested: boolean) => {
  const found: string[] = []
  for (const name of CONFIG_FILENAMES) {
    const path = resolve(dir, name)
    if (await isFile(path)) found.push(path)
  }
  if (!nested) return found
  for (const name of CONFIG_FILENAMES) {
    const path = resolve(dir, ".opencode", name)
    if (await isFile(path)) found.push(path)
  }
  return found
}

const chainFromRoot = async (directory: string) => {
  let dir = await realpath(directory)
  const chain = [dir]
  while (true) {
    const parent = dirname(dir)
    if (parent === dir) break
    chain.push(parent)
    dir = parent
  }
  return chain.reverse()
}

/**
 * Config documents this process would load when loopback provenance cannot
 * authenticate. Lowest priority first. `serve --stdio` removes the server
 * password from the environment before plugins start, so the HTTP reader
 * cannot present it.
 */
export async function readInstalledConfiguration(directory: string, env: NodeJS.ProcessEnv = process.env): Promise<readonly ConfigEntry[]> {
  const paths: string[] = []
  const push = async (path: string) => {
    if (!(await isFile(path))) return
    const resolved = await realpath(path)
    if (!paths.includes(resolved)) paths.push(resolved)
  }
  const globalDir = installedConfigDirectory(env)
  for (const path of await filesIn(globalDir, false)) await push(path)
  const globalReal = await realpath(globalDir).catch(missing)
  const projectDisabled = enabledFlag(env.OPENCODE_CONFIG_PROJECT_DISABLE) || enabledFlag(env.OPENCODE_DISABLE_PROJECT_CONFIG)
  if (!projectDisabled) {
    for (const dir of await chainFromRoot(directory)) {
      if (globalReal !== undefined && samePath(globalReal, dir)) continue
      for (const path of await filesIn(dir, true)) await push(path)
    }
  }
  if (env.OPENCODE_CONFIG) await push(resolve(env.OPENCODE_CONFIG))
  const entries: ConfigEntry[] = []
  for (const path of paths) {
    const info = parseProjectConfig(await readFile(path, "utf8")) as Extract<ConfigEntry, { type: "document" }>["info"]
    entries.push({ type: "document", path, info })
  }
  return entries
}

export async function readProjectQuartermasterOptions(directory: string, readConfiguration: ConfigurationReader = readNativeConfiguration) {
  const target = await effectiveEntry(directory, readConfiguration)
  return { path: target.path, revision: target.revision, options: target.options, config: target.config, writable: target.writable }
}

const readAdoptedOptions = async (directory: string, readConfiguration: ConfigurationReader) => {
  try {
    return await readProjectQuartermasterOptions(directory, readConfiguration)
  } catch (error) {
    // A supplied reader is the test and gateway contract. Only the native
    // loopback reader may fall back to the files this process would load.
    if (readConfiguration !== readNativeConfiguration || !(error instanceof ProjectConfigurationUnresolved)) throw error
    return readProjectQuartermasterOptions(directory, (root) => readInstalledConfiguration(root))
  }
}

export async function adoptProjectQuartermasterOptions(config: QuartermasterConfig, directory: string, readConfiguration: ConfigurationReader = readNativeConfiguration) {
  const loaded = await readAdoptedOptions(directory, readConfiguration)
  Object.assign(config, loaded.config)
  if (loaded.config.budgets === undefined) delete config.budgets
  if (loaded.config.tokenRates === undefined) delete config.tokenRates
  if (loaded.config.modules === undefined) delete config.modules
  return loaded
}
