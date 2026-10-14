import { copyFile, lstat, mkdir, readFile, realpath, rmdir, stat, writeFile as writeFileDefault } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { OpenCode, type ConfigEntry } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { parseConfig, type QuartermasterConfig } from "./config.ts"

export type ConfigurationReader = (directory: string) => Promise<readonly ConfigEntry[]>

export const readNativeConfiguration: ConfigurationReader = async (directory) => {
  const signal = AbortSignal.timeout(2_000)
  const endpoint = await Service.discover()
  if (!endpoint) throw new Error("Receiving server configuration provenance is unavailable")
  const url = new URL(endpoint.url)
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password)
    throw new Error("Receiving server configuration provenance is unavailable")
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  const info = await client.server.info({ signal })
  if (info.pid !== process.pid) throw new Error("Receiving server configuration provenance is unavailable")
  return client.config.get({ location: { directory } }, { signal })
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

const enclosingObject = (blanked: string, index: number) => {
  const stack: number[] = []
  for (let cursor = 0; cursor < blanked.length; cursor += 1) {
    if (blanked[cursor] === "\"") {
      cursor = endString(blanked, cursor) - 1
      continue
    }
    if (blanked[cursor] === "{") stack.push(cursor)
    if (blanked[cursor] === "}") {
      const start = stack.pop()
      if (start !== undefined && start <= index && index <= cursor) return { start, end: cursor + 1 }
    }
  }
  throw new Error("Quartermaster plugin entry is not an object")
}

const optionsValueSpan = (blanked: string, start: number, end: number) => {
  let index = start + 1
  let depth = 1
  while (index < end && depth > 0) {
    if (blanked[index] === "\"") {
      const keyStart = index
      const keyEnd = endString(blanked, index)
      const key = JSON.parse(blanked.slice(keyStart, keyEnd)) as unknown
      index = keyEnd
      while (index < end && blanked[index] <= " ") index += 1
      if (blanked[index] !== ":") continue
      index += 1
      while (index < end && blanked[index] <= " ") index += 1
      const valueStart = index
      if (key === "options" && depth === 1) {
        if (blanked[index] !== "{") throw new Error("Quartermaster plugin entry has no options object")
        let valueDepth = 0
        while (index < end) {
          if (blanked[index] === "\"") {
            index = endString(blanked, index)
            continue
          }
          if (blanked[index] === "{") valueDepth += 1
          if (blanked[index] === "}") {
            valueDepth -= 1
            if (valueDepth === 0) return { start: valueStart, end: index + 1 }
          }
          index += 1
        }
      }
      continue
    }
    if (blanked[index] === "{") depth += 1
    if (blanked[index] === "}") depth -= 1
    index += 1
  }
  throw new Error("Quartermaster plugin entry has no options object")
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
  if (!Array.isArray(sources)) throw new Error("Invalid configuration provenance")
  let selected: { path?: string, options: unknown } | undefined
  for (const source of sources) {
    if (source.type === "directory") continue
    if (source.type !== "document" || !source.info || typeof source.info !== "object")
      throw new Error("Invalid configuration provenance")
    if (source.path && insideDirectory(root, resolve(source.path))) {
      const path = await containedPath(root, source.path)
      if (!path) throw new Error("Project config changed; refusing to overwrite")
      const text = await readFile(path, "utf8")
      parseProjectConfig(text)
      packageSpans(blankComments(text))
    }
    const plugins = source.info.plugins ?? []
    if (!Array.isArray(plugins)) throw new Error("Invalid configuration provenance")
    const matches: { options: unknown }[] = []
    for (const plugin of plugins) {
      const spec = typeof plugin === "string" ? plugin : plugin.package
      if (typeof spec !== "string") throw new Error("Invalid configuration provenance")
      if (!source.path && localPackageSpec(spec) && !isAbsolute(spec) && !spec.startsWith("file:"))
        throw new Error("Relative plugin source has no configuration path")
      if (await isThisPackage(spec, source.path ?? resolve(root, "opencode.json"), packageRoot))
        matches.push({ options: typeof plugin === "string" ? {} : plugin.options ?? {} })
    }
    if (matches.length > 1) throw new Error("Expected exactly one Quartermaster plugin entry per configuration document")
    if (matches.length === 1) selected = { path: source.path, options: matches[0].options }
  }
  if (!selected) throw new Error("Expected exactly one project Quartermaster plugin entry")
  const config = parseConfig(selected.options)
  if (!selected.path) return { ...selected, config, revision: 0, writable: false }
  // Inherited and virtual sources are readable, never writable through a project editor.
  if (!insideDirectory(root, resolve(selected.path)))
    return { ...selected, config, revision: 0, writable: false }
  const path = await containedPath(root, selected.path)
  if (!path) throw new Error("Project config changed; refusing to overwrite")
  const text = await readFile(path, "utf8")
  parseProjectConfig(text)
  const blanked = blankComments(text)
  const matches = []
  for (const span of packageSpans(blanked)) {
    if (await isThisPackage(span.value, path, packageRoot)) matches.push(span)
  }
  if (matches.length !== 1) throw new Error("Expected exactly one project Quartermaster plugin entry")
  const object = enclosingObject(blanked, matches[0].start)
  const span = optionsValueSpan(blanked, object.start, object.end)
  if (!isDeepStrictEqual(parseProjectConfig(text.slice(span.start, span.end)), selected.options))
    throw new Error("Project config changed; refusing to overwrite")
  const revision = createHash("sha256").update(JSON.stringify([root, path, text])).digest().readUIntBE(0, 6)
  return { path, text, span, options: selected.options, config, revision, writable: true }
}

const renderOptions = (text: string, span: { start: number, end: number }, options: unknown) => {
  const lineStart = text.lastIndexOf("\n", span.start) + 1
  const indent = text.slice(lineStart, span.start).match(/^\s*/)?.[0] ?? ""
  const rendered = JSON.stringify(options, null, 2)
    .split("\n")
    .map((line, index) => index === 0 ? line : `${indent}${line}`)
    .join("\n")
  return `${text.slice(0, span.start)}${rendered}${text.slice(span.end)}`
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
    if (!target.writable || !target.path || target.text === undefined || !target.span)
      throw new Error("Effective Quartermaster options are outside the writable project configuration")
    if (target.revision !== input.revision) throw new Error("Project config changed; refusing to overwrite")
    const next = renderOptions(target.text, target.span, input.options)
    const backup = (await containedPath(root, `${target.path}.quartermaster.bak`, true))!
    if (await containedPath(root, target.path) !== target.path) throw new Error("Project config changed; refusing to overwrite")
    await copyFile(target.path, backup)
    const current = await effectiveEntry(root, readConfiguration)
    if (!current.writable || current.path !== target.path || current.revision !== input.revision)
      throw new Error("Project config changed; refusing to overwrite")
    try {
      if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("The operation was aborted", "AbortError")
      if (await containedPath(root, target.path) !== target.path) throw new Error("Project config changed; refusing to overwrite")
      await (io.writeFile ?? writeFileDefault)(target.path, next, input.signal ? { signal: input.signal } : undefined)
      if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("The operation was aborted", "AbortError")
    } catch (error) {
      await containedPath(root, target.path, true).then(path => {
        if (path !== undefined) return writeFileDefault(path, target.text)
      }).catch(() => undefined)
      throw error
    }
    return { path: target.path, backup }
  } finally {
    await rmdir(lock)
  }
}

export async function readProjectQuartermasterOptions(directory: string, readConfiguration: ConfigurationReader = readNativeConfiguration) {
  const target = await effectiveEntry(directory, readConfiguration)
  return { path: target.path, revision: target.revision, options: target.options, config: target.config, writable: target.writable }
}

export async function adoptProjectQuartermasterOptions(config: QuartermasterConfig, directory: string, readConfiguration: ConfigurationReader = readNativeConfiguration) {
  const loaded = await readProjectQuartermasterOptions(directory, readConfiguration)
  Object.assign(config, loaded.config)
  if (loaded.config.budgets === undefined) delete config.budgets
  if (loaded.config.tokenRates === undefined) delete config.tokenRates
  return loaded
}
