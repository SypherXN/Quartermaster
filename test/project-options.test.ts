import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createServer } from "node:http"
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import { promisify } from "node:util"
import { parseConfig } from "../src/config.ts"
import { adoptProjectQuartermasterOptions as adoptOptions, applyProjectQuartermasterOptions as applyOptions, readProjectQuartermasterOptions as readOptions, parseProjectConfig, readNativeConfiguration } from "../src/project-options.ts"
import { Service } from "@opencode/client/service"
import { fixtureConfiguration } from "./configuration-fixture.ts"
import { resolvePlan } from "../src/select.ts"

const readProjectQuartermasterOptions = (directory: string) => readOptions(directory, fixtureConfiguration)
const adoptProjectQuartermasterOptions = (config: Parameters<typeof adoptOptions>[0], directory: string) => adoptOptions(config, directory, fixtureConfiguration)
const applyProjectQuartermasterOptions = (input: Parameters<typeof applyOptions>[0], io?: Parameters<typeof applyOptions>[1]) => applyOptions({ ...input, readConfiguration: fixtureConfiguration }, io)

const projectConfig = `{
  // keep this comment
  "model": "unchanged",
  "plugins": [
    "other-plugin",
    {
      "package": "quartermaster",
      "options": {
        "plans": { "review": ["provider-a/old"] }
      }
    }
  ]
}
`

const writeProject = async (root: string, text = projectConfig, name = "opencode.jsonc") => {
  const path = join(root, name)
  await writeFile(path, text)
  return path
}

test("replaces only Quartermaster options and preserves comments", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-options-"))
  try {
    const path = await writeProject(root)
    const revision = (await readProjectQuartermasterOptions(root)).revision
    const options = { plans: { review: ["provider-a/new"] }, agents: { reviewer: "review" } }
    await applyProjectQuartermasterOptions({ directory: root, options, revision })
    const next = await readFile(path, "utf8")
    assert.match(next, /keep this comment/)
    assert.match(next, /"model": "unchanged"/)
    assert.match(next, /"other-plugin"/)
    assert.match(next, /provider-a\/new/)
    assert.doesNotMatch(next, /provider-a\/old/)
    assert.equal(await readFile(`${path}.quartermaster.bak`, "utf8"), projectConfig)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects package fields outside direct top-level plugin entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-options-scope-"))
  const decoy = { package: "quartermaster", options: { plans: { review: ["provider-a/old"] } } }
  try {
    for (const config of [
      { plugins: [], metadata: decoy },
      { plugins: [{ package: "other-plugin", options: decoy }] },
      { metadata: { plugins: [decoy] } },
    ]) {
      const text = JSON.stringify(config)
      const path = await writeProject(root, text)
      const revision = (await stat(path)).mtimeMs
      await assert.rejects(() => readProjectQuartermasterOptions(root), /exactly one/)
      await assert.rejects(() => applyProjectQuartermasterOptions({
        directory: root,
        options: { plans: { review: ["provider-a/new"] } },
        revision,
      }), /exactly one/)
      assert.equal(await readFile(path, "utf8"), text)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("updates the direct plugin entry without touching unrelated package fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-options-scope-"))
  const decoy = { package: "quartermaster", options: { plans: { review: ["provider-a/decoy"] } } }
  const config = {
    metadata: decoy,
    plugins: [
      { package: "other-plugin", options: decoy },
      { package: "quartermaster", options: { plans: { review: ["provider-a/old"] } } },
    ],
  }
  try {
    const path = await writeProject(root, JSON.stringify(config))
    const loaded = await readProjectQuartermasterOptions(root)
    assert.deepEqual(loaded.options, config.plugins[1].options)
    const options = { plans: { review: ["provider-a/new"] } }
    await applyProjectQuartermasterOptions({ directory: root, options, revision: loaded.revision })
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      ...config,
      plugins: [config.plugins[0], { package: "quartermaster", options }],
    })
    assert.deepEqual((await readProjectQuartermasterOptions(root)).options, options)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const [name, key, text] of [
  ["shadowed plugins", "plugins", '{"plugins":[{"package":"quartermaster","options":{}}],"plugins":["other-plugin"]}'],
  ["later plugins", "plugins", '{"plugins":null,"plugins":[{"package":"quartermaster","options":{}}]}'],
  ["shadowed options", "options", '{"plugins":[{"package":"quartermaster","options":{},"options":{"plans":{"review":["provider-a/old"]}}}]}'],
  ["later options", "options", '{"plugins":[{"options":null,"package":"quartermaster","options":{}}]}'],
  ["escaped plugins", "plugins", '{/* preserve */"plugins":[{"package":"quartermaster","options":{}}],"plu\\u0067ins":[]}'],
  ["escaped options", "options", '{"plugins":[{"package":"quartermaster","options":{},"opti\\u006fns":{}}]}'],
  ["shadowed package", "package", '{"plugins":[{"package":"quartermaster","package":"other-plugin","options":{}}]}'],
  ["later package", "package", '{"plugins":[{"package":"other-plugin","package":"quartermaster","options":{}}]}'],
  ["non-string package", "package", '{"plugins":[{"package":null,"package":"quartermaster","options":{}}]}'],
  ["escaped package", "package", '{"plugins":[{"package":"quartermaster","pack\\u0061ge":"other-plugin","options":{}}]}'],
  ["escaped first package", "package", '{"plugins":[{"pack\\u0061ge":"other-plugin","package":"quartermaster","options":{}}]}'],
] as const) {
  test(`rejects ambiguous ${name} without writing or creating a backup`, async () => {
    const root = await mkdtemp(join(tmpdir(), "qm-options-duplicate-"))
    try {
      const path = await writeProject(root, text)
      const revision = (await stat(path)).mtimeMs
      const error = new RegExp(`Duplicate "${key}" key`)
      await assert.rejects(() => readProjectQuartermasterOptions(root), error)
      const config = parseConfig({ plans: { keep: ["provider-a/keep"] } })
      const original = structuredClone(config)
      await assert.rejects(() => adoptProjectQuartermasterOptions(config, root), error)
      assert.deepEqual(config, original)
      let writes = 0
      await assert.rejects(() => applyProjectQuartermasterOptions({
        directory: root, options: { plans: { review: ["provider-a/new"] } }, revision,
      }, { writeFile: async () => { writes += 1 } }), error)
      assert.equal(writes, 0)
      assert.equal(await readFile(path, "utf8"), text)
      assert.equal((await stat(path)).mtimeMs, revision)
      await assert.rejects(() => stat(`${path}.quartermaster.bak`), { code: "ENOENT" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("accepts scoped keys and escaped names while preserving JSONC", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-options-keys-"))
  const text = String.raw`{
    // Fake duplicates: "plugins": [], "plugins": [], "options": {}, "options": {}, "package": "quartermaster", "package": "other-plugin"
    "metadata": { "plugins": [], "options": { "nested": { "options": {} }, "labels": ["options", "plugins", "{\"options\":{},\"options\":{}}"] } },
    "plu\u0067ins": [
      { "package": "other-plugin", "options": {} },
      { "pack\u0061ge": "quartermaster", "opti\u006fns": { "plans": { "review": ["provider-a/old"] } } }
    ]
  }`
  try {
    const path = await writeProject(root, text)
    const loaded = await readProjectQuartermasterOptions(root)
    assert.deepEqual(loaded.options, { plans: { review: ["provider-a/old"] } })
    const options = { plans: { review: ["provider-a/new"] } }
    await applyProjectQuartermasterOptions({ directory: root, options, revision: loaded.revision })
    const next = await readFile(path, "utf8")
    const [prefix, suffix] = text.split('{ "plans": { "review": ["provider-a/old"] } }')
    assert.ok(next.startsWith(prefix))
    assert.ok(next.endsWith(suffix))
    assert.deepEqual((await readProjectQuartermasterOptions(root)).options, options)
    assert.equal(await readFile(`${path}.quartermaster.bak`, "utf8"), text)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const separateProcess of [false, true]) {
  test(`rejects a competing apply ${separateProcess ? "from another process" : "in the same process"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "qm-options-concurrent-"))
    const other = await mkdtemp(join(tmpdir(), "qm-options-independent-"))
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    let pending: Promise<unknown> | undefined
    try {
      const path = await writeProject(root)
      const otherPath = await writeProject(other)
      const revision = (await readProjectQuartermasterOptions(root)).revision
      const options = { plans: { review: ["provider-a/winner"] } }
      pending = applyProjectQuartermasterOptions({ directory: root, revision, options }, {
        writeFile: async (file, contents) => {
          enter()
          await released
          await writeFile(file, contents)
        },
      })
      await entered
      const competitor = { directory: root, revision, options: { plans: { review: ["provider-a/loser"] } } }
      if (separateProcess) {
        const module = new URL("../src/project-options.ts", import.meta.url).href
        const code = `import { applyProjectQuartermasterOptions } from ${JSON.stringify(module)};
          try { await applyProjectQuartermasterOptions(${JSON.stringify(competitor)}); console.log('saved'); }
          catch (error) { console.log(error.message); }`
        const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], { timeout: 10000 })
        assert.match(result.stdout, /update already in progress/)
      } else {
        await assert.rejects(() => applyProjectQuartermasterOptions(competitor), /update already in progress/)
      }
      assert.equal(await readFile(path, "utf8"), projectConfig)
      assert.equal(await readFile(`${path}.quartermaster.bak`, "utf8"), projectConfig)
      await applyProjectQuartermasterOptions({ directory: other, revision: (await readProjectQuartermasterOptions(other)).revision, options })
      release()
      await pending
      assert.deepEqual((await readProjectQuartermasterOptions(root)).options, options)
      await assert.rejects(() => applyProjectQuartermasterOptions(competitor), /refusing to overwrite/)
      const loaded = await readProjectQuartermasterOptions(root)
      await applyProjectQuartermasterOptions({ ...competitor, revision: loaded.revision })
      assert.deepEqual((await readProjectQuartermasterOptions(root)).options, competitor.options)
    } finally {
      release()
      await pending?.catch(() => undefined)
      await rm(root, { recursive: true, force: true })
      await rm(other, { recursive: true, force: true })
    }
  })
}

for (const kind of ["directory", "config", "backup", "backup directory", "dangling backup"] as const) {
  test(`rejects an escaping ${kind} link without modifying either project`, async t => {
    const fixture = await mkdtemp(join(tmpdir(), "qm-options-containment-"))
    const root = join(fixture, "project")
    const other = join(fixture, "project-other")
    try {
      await mkdir(root)
      await mkdir(other)
      const otherPath = await writeProject(other)
      let path: string
      if (kind === "directory") {
        await symlink(other, join(root, ".opencode"), process.platform === "win32" ? "junction" : "dir")
        path = join(root, ".opencode", "opencode.jsonc")
      } else if (kind === "config") {
        path = join(root, "opencode.jsonc")
        await symlink(otherPath, path, "file")
      } else {
        path = await writeProject(root)
        if (kind === "backup directory") {
          await symlink(other, `${path}.quartermaster.bak`, process.platform === "win32" ? "junction" : "dir")
        } else {
          await symlink(kind === "backup" ? otherPath : join(other, "missing.json"), `${path}.quartermaster.bak`, "file")
        }
      }
      const revision = (await stat(path)).mtimeMs
      const writeRevision = kind === "directory" || kind === "config" ? revision : (await readProjectQuartermasterOptions(root)).revision
      if (kind === "directory" || kind === "config") {
        await assert.rejects(() => readProjectQuartermasterOptions(root), /outside project/)
        const config = parseConfig({})
        const original = structuredClone(config)
        await assert.rejects(() => adoptProjectQuartermasterOptions(config, root), /outside project/)
        assert.deepEqual(config, original)
      }
      let writes = 0
      await assert.rejects(() => applyProjectQuartermasterOptions({
        directory: root, options: { plans: { review: ["provider-a/new"] } }, revision: writeRevision,
      }, { writeFile: async () => { writes += 1 } }), /outside project|unresolvable link/)
      assert.equal(writes, 0)
      assert.equal(await readFile(otherPath, "utf8"), projectConfig)
      assert.equal(await readFile(path, "utf8"), projectConfig)
      assert.equal((await stat(path)).mtimeMs, revision)
      await assert.rejects(() => stat(`${otherPath}.quartermaster.bak`), { code: "ENOENT" })
      await assert.rejects(() => stat(join(other, "missing.json")), { code: "ENOENT" })
      await assert.rejects(() => stat(join(root, ".quartermaster-options.lock")), { code: "ENOENT" })
    } catch (error) {
      const failure = error as NodeJS.ErrnoException
      if (process.platform !== "win32" || failure.code !== "EPERM" || failure.syscall !== "symlink") throw error
      t.skip("Windows file symlinks require Developer Mode or elevated privileges")
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
}

test("resolves the project root and permits links contained within it", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "qm-options-contained-"))
  try {
    const root = join(fixture, "project")
    const nested = join(root, "config")
    const alias = join(fixture, "project-alias")
    await mkdir(nested, { recursive: true })
    const type = process.platform === "win32" ? "junction" : "dir"
    await symlink(root, alias, type)
    await symlink(nested, join(root, ".opencode"), type)
    const path = await writeProject(nested)
    const loaded = await readProjectQuartermasterOptions(alias)
    assert.equal(loaded.path, await realpath(path))
    const options = { plans: { review: ["provider-a/new"] } }
    await applyProjectQuartermasterOptions({ directory: alias, revision: loaded.revision, options })
    assert.deepEqual((await readProjectQuartermasterOptions(root)).options, options)
    assert.equal(await readFile(`${path}.quartermaster.bak`, "utf8"), projectConfig)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

for (const backup of [false, true]) {
  test(`rejects a ${backup ? "backup" : "config"} hard link shared with another project`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), "qm-options-hardlink-"))
    const root = join(fixture, "project")
    const other = join(fixture, "project-other")
    try {
      await mkdir(root)
      await mkdir(other)
      const otherPath = await writeProject(other)
      const path = join(root, "opencode.jsonc")
      if (backup) await writeProject(root)
      await link(otherPath, backup ? `${path}.quartermaster.bak` : path)
      const revision = (await stat(path)).mtimeMs
      const writeRevision = backup ? (await readProjectQuartermasterOptions(root)).revision : revision
      const otherRevision = (await stat(otherPath)).mtimeMs
      if (!backup) await assert.rejects(() => readProjectQuartermasterOptions(root), /multiple hard links/)
      let writes = 0
      await assert.rejects(() => applyProjectQuartermasterOptions({ directory: root, revision: writeRevision, options: {} }, {
        writeFile: async () => { writes += 1 },
      }), /multiple hard links/)
      assert.equal(writes, 0)
      assert.equal(await readFile(path, "utf8"), projectConfig)
      assert.equal(await readFile(otherPath, "utf8"), projectConfig)
      assert.equal((await stat(otherPath)).mtimeMs, otherRevision)
      assert.equal((await stat(path)).mtimeMs, revision)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
}

test("rollback refuses a directory retargeted outside the project", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "qm-options-rollback-link-"))
  const root = join(fixture, "project")
  const nested = join(root, ".opencode")
  const other = join(fixture, "project-other")
  try {
    await mkdir(nested, { recursive: true })
    await mkdir(other)
    const path = await writeProject(nested)
    const otherText = projectConfig.replace("provider-a/old", "provider-a/other")
    const otherPath = await writeProject(other, otherText)
    const revision = (await readProjectQuartermasterOptions(root)).revision
    await assert.rejects(() => applyProjectQuartermasterOptions({ directory: root, options: {}, revision }, {
      writeFile: async () => {
        await rename(nested, join(root, "original"))
        await symlink(other, nested, process.platform === "win32" ? "junction" : "dir")
        throw new Error("retargeted during failed write")
      },
    }), /retargeted during failed write/)
    assert.equal(await readFile(otherPath, "utf8"), otherText)
    assert.equal(await readFile(join(root, "original", "opencode.jsonc"), "utf8"), projectConfig)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test("does not change another project", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-options-"))
  const other = await mkdtemp(join(tmpdir(), "qm-options-other-"))
  try {
    const path = await writeProject(root)
    const otherPath = await writeProject(other)
    const before = await readFile(otherPath, "utf8")
    await applyProjectQuartermasterOptions({
      directory: root,
      options: { plans: { review: ["provider-a/new"] } },
      revision: (await readProjectQuartermasterOptions(root)).revision,
    })
    assert.equal(await readFile(otherPath, "utf8"), before)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})

test("does not remove an existing project lock or change config or backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-options-locked-"))
  try {
    const path = await writeProject(root)
    const lock = join(root, ".quartermaster-options.lock")
    await mkdir(lock)
    await writeFile(join(lock, "owner"), "another writer")
    const revision = (await stat(path)).mtimeMs
    await assert.rejects(() => applyProjectQuartermasterOptions({
      directory: root, options: {}, revision,
    }), /update already in progress/)
    assert.equal(await readFile(path, "utf8"), projectConfig)
    assert.equal(await readFile(join(lock, "owner"), "utf8"), "another writer")
    await assert.rejects(() => stat(`${path}.quartermaster.bak`), { code: "ENOENT" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects malformed config, duplicates, and a stale revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-options-"))
  try {
    const path = await writeProject(root, "{ not json")
    await assert.rejects(() => applyProjectQuartermasterOptions({ directory: root, options: {}, revision: 1 }))
    await writeProject(root, `{
      "plugins": [
        { "package": "quartermaster", "options": {} },
        { "package": "quartermaster", "options": {} }
      ]
    }`)
    const before = await readFile(path, "utf8")
    const revision = (await stat(path)).mtimeMs
    await assert.rejects(
      () => applyProjectQuartermasterOptions({ directory: root, options: {}, revision }),
      /exactly one/,
    )
    assert.equal(await readFile(path, "utf8"), before)
    await writeProject(root)
    await assert.rejects(
      () => applyProjectQuartermasterOptions({ directory: root, options: {}, revision: 1 }),
      /refusing to overwrite/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects invalid options and restores the file when the write fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-options-"))
  try {
    const path = await writeProject(root)
    const revision = (await readProjectQuartermasterOptions(root)).revision
    await assert.rejects(
      () => applyProjectQuartermasterOptions({ directory: root, options: { unknown: true }, revision }),
      /unknown field/,
    )
    assert.equal(await readFile(path, "utf8"), projectConfig)
    await assert.rejects(() => applyProjectQuartermasterOptions(
      { directory: root, options: { plans: { review: ["provider-a/new"] } }, revision },
      { writeFile: async () => { throw new Error("disk full") } },
    ))
    assert.equal(await readFile(path, "utf8"), projectConfig)
    await assert.rejects(() => stat(join(root, ".quartermaster-options.lock")), { code: "ENOENT" })
    await applyProjectQuartermasterOptions({ directory: root, options: {}, revision: (await readProjectQuartermasterOptions(root)).revision })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("restores the project file when an options write is cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-options-abort-"))
  const controller = new AbortController()
  try {
    const path = await writeProject(root)
    const revision = (await readProjectQuartermasterOptions(root)).revision
    await assert.rejects(() => applyProjectQuartermasterOptions({
      directory: root,
      options: { plans: { review: ["provider-a/new"] } },
      revision,
      signal: controller.signal,
    }, { writeFile: async (file, contents) => {
      await writeFile(file, contents)
      controller.abort()
    } }))
    assert.equal(await readFile(path, "utf8"), projectConfig)
    await assert.rejects(() => stat(join(root, ".quartermaster-options.lock")), { code: "ENOENT" })
    await applyProjectQuartermasterOptions({ directory: root, options: {}, revision: (await readProjectQuartermasterOptions(root)).revision })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("updates only the effective project document selected by native precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-options-"))
  try {
    await mkdir(join(root, ".opencode"))
    const path = await writeProject(root, projectConfig, "opencode.json")
    const nested = await writeProject(root, projectConfig, join(".opencode", "opencode.json"))
    const loaded = await readProjectQuartermasterOptions(root)
    assert.equal(loaded.path, nested)
    await applyProjectQuartermasterOptions({ directory: root, options: {}, revision: loaded.revision })
    assert.equal(await readFile(path, "utf8"), projectConfig)
    assert.deepEqual(JSON.parse((await readFile(nested, "utf8")).replace(/\/\/[^\n]*/g, "")).plugins[1].options, {})
    assert.equal(await readFile(`${nested}.quartermaster.bak`, "utf8"), projectConfig)
    await assert.rejects(() => stat(`${path}.quartermaster.bak`), { code: "ENOENT" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a later assignment uses the applied project options", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-options-"))
  const text = `{
    "plugins": [{
      "package": "quartermaster",
      "options": { "plans": { "review": ["provider-a/old"] }, "agents": { "reviewer": "review" } }
    }]
  }
`
  try {
    const path = await writeProject(root, text, "opencode.json")
    const config = parseConfig({
      plans: { global: ["provider-a/global"] },
      agents: { globalAgent: "global" },
      usageSources: { "provider-a": "codex" },
      localEndpoints: { "provider-a": "http://127.0.0.1:11434" },
    })
    await adoptProjectQuartermasterOptions(config, root)
    assert.deepEqual(config.plans, { review: [{ providerID: "provider-a", modelID: "old" }] })
    assert.deepEqual(config.agents, { reviewer: "review" })
    assert.deepEqual(config.usageSources, {})
    assert.deepEqual(config.localEndpoints, {})
    const first = resolvePlan(config, "reviewer")
    assert.equal(first.status, "plan")
    if (first.status === "plan") assert.equal(first.plan[0].modelID, "old")
    await applyProjectQuartermasterOptions({
      directory: root,
      options: { plans: { review: ["provider-a/new"] }, agents: { reviewer: "review" } },
      revision: (await readProjectQuartermasterOptions(root)).revision,
    })
    await adoptProjectQuartermasterOptions(config, root)
    const second = resolvePlan(config, "reviewer")
    assert.equal(second.status, "plan")
    if (second.status === "plan") assert.equal(second.plan[0].modelID, "new")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("matches only this Quartermaster package", async () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url))
  const root = await mkdtemp(join(tmpdir(), "qm-options-identity-"))
  const decoyRoot = await mkdtemp(join(tmpdir(), "qm-options-decoy-"))
  try {
    const decoy = join(decoyRoot, "Quartermaster", "unrelated-plugin")
    await mkdir(decoy, { recursive: true })
    await writeFile(join(decoy, "package.json"), JSON.stringify({ name: "unrelated-plugin" }))
    await writeFile(join(decoy, "index.js"), "")
    const untouched = { plans: { p: ["fixture/old"] } }
    for (const pkg of ["not-quartermaster", "quartermaster-extra", "github:SypherXN/other", "github:SypherXN/quartermaster-extra", "C:/workspace/Quartermaster/unrelated-plugin/index.js", decoy]) {
      const text = JSON.stringify({ plugins: [{ package: pkg, options: untouched }] })
      const path = await writeProject(root, text, "opencode.json")
      const revision = (await stat(path)).mtimeMs
      await assert.rejects(() => readProjectQuartermasterOptions(root), /exactly one/)
      await assert.rejects(() => applyProjectQuartermasterOptions({
        directory: root, options: { plans: { p: ["fixture/new"] } }, revision,
      }), /exactly one/)
      assert.equal(await readFile(path, "utf8"), text)
      assert.equal((await stat(path)).mtimeMs, revision)
      await assert.rejects(() => stat(`${path}.quartermaster.bak`), { code: "ENOENT" })
      await assert.rejects(() => stat(join(root, ".quartermaster-options.lock")), { code: "ENOENT" })
    }

    const relativeSpec = relative(root, packageRoot)
    assert.match(relativeSpec, /^\.\.[\\/]/)
    for (const pkg of ["opencode-quartermaster", "opencode-quartermaster@0.1.0", "quartermaster", "quartermaster@0.1.0", "github:SypherXN/quartermaster#main", "github:SypherXN/quartermaster.git#main", "https://github.com/SypherXN/quartermaster", "git+https://github.com/SypherXN/quartermaster.git", relativeSpec, packageRoot, pathToFileURL(packageRoot).href]) {
      const text = JSON.stringify({
        plugins: [
          { package: "not-quartermaster", options: untouched },
          { package: pkg, options: { plans: { review: ["provider-a/old"] } } },
        ],
      })
      const path = await writeProject(root, text, "opencode.json")
      const loaded = await readProjectQuartermasterOptions(root)
      assert.deepEqual(loaded.options, { plans: { review: ["provider-a/old"] } })
      const options = { plans: { review: ["provider-a/new"] } }
      await applyProjectQuartermasterOptions({ directory: root, options, revision: loaded.revision })
      const saved = JSON.parse(await readFile(path, "utf8"))
      assert.equal(saved.plugins[0].package, "not-quartermaster")
      assert.deepEqual(saved.plugins[0].options, untouched)
      assert.equal(saved.plugins[1].package, pkg)
      assert.deepEqual(saved.plugins[1].options, options)
    }

    const example = await readProjectQuartermasterOptions(fileURLToPath(new URL("../examples/test-agent", import.meta.url)))
    assert.deepEqual(example.options, {
      plans: { "test-agent": ["ninfer/qwen3.8-27b", "opencode/space-bunny-free"] },
      agents: { "qm-test": "test-agent", "quartermaster-test": "test-agent" },
      localEndpoints: { ninfer: "http://127.0.0.1:8080/v1/models" },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(decoyRoot, { recursive: true, force: true })
  }
})

test("follows native global, ancestor, project and .opencode ordering without writing inherited files", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "qm-options-precedence-"))
  const root = join(fixture, "ancestor", "project")
  try {
    await mkdir(join(root, ".opencode"), { recursive: true })
    await mkdir(join(fixture, "ancestor", ".opencode"))
    const paths = [join(fixture, "system.json"), join(fixture, "global.json"), join(fixture, "ancestor", "opencode.json"), join(root, "opencode.json"), join(fixture, "ancestor", ".opencode", "opencode.jsonc"), join(root, ".opencode", "opencode.jsonc")]
    const texts = paths.map((_, index) => projectConfig.replace("provider-a/old", `fixture/model-${index}`))
    for (let index = 0; index < paths.length; index += 1) await writeFile(paths[index], texts[index])
    let count = 2
    const sources = async () => Promise.all(paths.slice(0, count).map(async path => ({ type: "document", path, info: parseProjectConfig(await readFile(path, "utf8")) } as never)))
    const global = await readOptions(root, sources)
    assert.deepEqual(global.options, { plans: { review: ["fixture/model-1"] } })
    assert.equal(global.writable, false)
    await assert.rejects(() => applyOptions({ directory: root, revision: global.revision, options: {}, readConfiguration: sources }), /outside the writable project/)
    count = 5
    const inherited = await readOptions(root, sources)
    assert.deepEqual(inherited.options, { plans: { review: ["fixture/model-4"] } })
    assert.equal(inherited.writable, false, "ancestor .opencode outranks nearer direct config")
    await assert.rejects(() => applyOptions({ directory: root, revision: inherited.revision, options: {}, readConfiguration: sources }), /outside the writable project/)
    count = 6
    const loaded = await readOptions(root, sources)
    assert.equal(loaded.path, paths[5])
    assert.equal(loaded.writable, true)
    await applyOptions({ directory: root, revision: loaded.revision, options: { plans: { review: ["fixture/updated"] } }, readConfiguration: sources })
    for (let index = 0; index < 5; index += 1) {
      assert.equal(await readFile(paths[index], "utf8"), texts[index])
      await assert.rejects(() => stat(`${paths[index]}.quartermaster.bak`), { code: "ENOENT" })
    }
    assert.deepEqual((await readOptions(root, sources)).options, { plans: { review: ["fixture/updated"] } })
    const inline = async () => [...await sources(), { type: "directory", path: root } as never, { type: "document", info: { plugins: [{ package: "quartermaster", options: { plans: { review: ["fixture/inline"] } } }] } } as never]
    const readonly = await readOptions(root, inline)
    assert.equal(readonly.writable, false)
    assert.deepEqual(readonly.options, { plans: { review: ["fixture/inline"] } })
    const before = await readFile(paths[5], "utf8")
    await assert.rejects(() => applyOptions({ directory: root, revision: loaded.revision, options: {}, readConfiguration: inline }), /outside the writable project/)
    assert.equal(await readFile(paths[5], "utf8"), before)
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

test("preserves trailing-comma JSONC and rejects malformed commas and comments", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-options-jsonc-"))
  const text = '{\r\n  // keep , } and , ] here\r\n  "model": "literal,}]",\r\n  "plugins": [{"package":"quartermaster","options":{"plans":{"review":["fixture/old", /* keep */],},},},],\r\n}\r\n'
  try {
    const path = await writeProject(root, text)
    const loaded = await readProjectQuartermasterOptions(root)
    await applyProjectQuartermasterOptions({ directory: root, revision: loaded.revision, options: { plans: { review: ["fixture/new"] } } })
    const next = await readFile(path, "utf8")
    assert.ok(next.startsWith(text.slice(0, text.indexOf('{"plans"'))))
    assert.ok(next.endsWith('},],\r\n}\r\n'))
    assert.deepEqual((parseProjectConfig(next) as any).plugins[0].options, { plans: { review: ["fixture/new"] } })
    assert.equal(await readFile(`${path}.quartermaster.bak`, "utf8"), text)
    for (const malformed of ['[,]', '{,}', '[1,,]', '{"x":,}', '{"x":1} /* unterminated']) assert.throws(() => parseProjectConfig(malformed))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("refuses stale native metadata and changed effective sources before any options write", async () => {
  const root = await mkdtemp(join(tmpdir(), "qm-options-source-change-"))
  try {
    await mkdir(join(root, ".opencode"))
    const path = await writeProject(root, projectConfig, "opencode.json")
    const nested = await writeProject(root, projectConfig, ".opencode/opencode.jsonc")
    const sources = await fixtureConfiguration(root)
    const loaded = await readOptions(root, async () => sources.slice(0, 1))
    let calls = 0
    let writes = 0
    await assert.rejects(() => applyOptions({ directory: root, revision: loaded.revision, options: {}, readConfiguration: async () => ++calls === 1 ? sources.slice(0, 1) : sources }, { writeFile: async () => { writes += 1 } }), /refusing to overwrite/)
    assert.equal(writes, 0)
    assert.equal(await readFile(path, "utf8"), projectConfig)
    assert.equal(await readFile(nested, "utf8"), projectConfig)
    const changed = projectConfig.replace('"unchanged"', '"changed"')
    await writeFile(path, changed)
    const current = await readOptions(root, async () => (await fixtureConfiguration(root)).slice(0, 1))
    assert.notEqual(current.revision, loaded.revision, "revision includes unrelated file content")
    await assert.rejects(() => applyOptions({ directory: root, revision: loaded.revision, options: {}, readConfiguration: async () => (await fixtureConfiguration(root)).slice(0, 1) }), /refusing to overwrite/)
    await writeFile(path, projectConfig.replace("provider-a/old", "provider-a/other"))
    await assert.rejects(() => readOptions(root, async () => sources.slice(0, 1)), /refusing to overwrite/)
    await assert.rejects(() => stat(join(root, ".quartermaster-options.lock")), { code: "ENOENT" })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("native discovery never starts a server or reads config from another process", async t => {
  let pid = process.pid + 1
  let reads = 0
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Basic ${Buffer.from("fixture:fixture-only").toString("base64")}`)
    const url = new URL(request.url!, "http://127.0.0.1")
    response.setHeader("Content-Type", "application/json")
    if (url.pathname === "/api/info") response.end(JSON.stringify({ version: "2.0.23", pid, urls: [], paths: {}, capabilities: {} }))
    else {
      assert.equal(url.pathname, "/api/config")
      assert.equal(url.searchParams.get("location[directory]"), "/fixture")
      reads += 1
      response.end("[]")
    }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const endpoint = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, auth: { type: "basic" as const, username: "fixture", password: "fixture-only" } }
  const discover = t.mock.method(Service, "discover", async () => endpoint)
  const ensure = t.mock.method(Service, "ensure", async () => { throw new Error("must not start a server") })
  try {
    await assert.rejects(() => readNativeConfiguration("/fixture"), /provenance is unavailable/)
    assert.equal(reads, 0)
    pid = process.pid
    assert.deepEqual(await readNativeConfiguration("/fixture"), [])
    assert.equal(reads, 1)
    discover.mock.mockImplementation(async () => undefined)
    await assert.rejects(() => readNativeConfiguration("/fixture"), /provenance is unavailable/)
    assert.equal(reads, 1)
    assert.equal(ensure.mock.callCount(), 0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
