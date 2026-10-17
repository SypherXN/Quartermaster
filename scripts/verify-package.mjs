import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Local pack/install only: fresh npm config, no lifecycle scripts during install, fake-provider host.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
assert.equal(metadata.name, "opencode-quartermaster")
assert.equal(metadata.private, true, "publishing must remain blocked")
assert.equal(metadata.license, "MIT")
assert.equal(metadata.dependencies["@opencode/plugin"], "2.0.23")
const npmCLI = process.env.npm_execpath
assert.ok(npmCLI, "Run this check with npm run verify-package")
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const suppliedArchive = option("archive")
const base = process.platform === "win32" ? join(homedir(), "AppData", "Local", "Temp", "opencode") : join(tmpdir(), "opencode")
await mkdir(base, { recursive: true })
const temp = await mkdtemp(join(base, "qm-package-"))
const home = join(temp, "home"), project = join(temp, "project"), artifacts = join(temp, "artifacts"), stage = join(temp, "stage")
await Promise.all([home, project, artifacts, stage].map((path) => mkdir(path, { recursive: true })))
const npmrc = join(home, "npmrc"), globalrc = join(home, "global-npmrc")
await Promise.all([npmrc, globalrc].map((path) => writeFile(path, "registry=https://registry.npmjs.org/\n")))
const env = Object.fromEntries(Object.entries({
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ComSpec: process.env.ComSpec,
  HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
  TEMP: home, TMP: home, XDG_CONFIG_HOME: join(home, ".config"),
  npm_config_userconfig: npmrc, npm_config_globalconfig: globalrc, npm_config_cache: join(home, "npm-cache"),
}).filter(([, value]) => value !== undefined))
function run(executable, args, cwd = root, timeout = 120_000) {
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.status, 0, `${executable} ${args.join(" ")}\n${result.error ?? ""}\n${result.stderr}\n${result.stdout}`)
  return result.stdout
}

try {
  let archive, paths
  if (suppliedArchive) {
    archive = resolve(suppliedArchive)
    paths = run("tar", ["-tzf", archive]).trim().split(/\r?\n/).filter((path) => !path.endsWith("/")).map((path) => path.replace(/^package\//, ""))
  } else {
    // Compile into owned staging storage; never rewrite checkout dist or an earlier archive.
    run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.build.json"), "--outDir", join(stage, "dist")])
    await Promise.all(["package.json", "index.js", "README.md", "LICENSE", "docs"].map((path) => cp(join(root, path), join(stage, path), { recursive: true })))
    const packed = JSON.parse(run(process.execPath, [npmCLI, "pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], stage))[0]
    archive = join(artifacts, packed.filename)
    paths = packed.files.map((file) => file.path)
  }
  for (const path of paths) {
    assert.match(path, /^(?:index\.js|dist\/(?:telemetry\/)?[a-z-]+\.(?:js|d\.ts)|docs\/[A-Z_]+\.md|README\.md|LICENSE|package\.json)$/,
      `Unexpected archive content: ${path}`)
  }
  for (const path of ["LICENSE", "package.json", "index.js", "dist/index.js", "dist/index.d.ts", "dist/rpc.js", "dist/rpc.d.ts"]) {
    assert.ok(paths.includes(path), `Archive is missing ${path}`)
  }
  const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex")
  await writeFile(join(project, "package.json"), JSON.stringify({ private: true, type: "module" }))
  run(process.execPath, [npmCLI, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", archive], project, 300_000)
  const installed = join(project, "node_modules", metadata.name)
  const smoke = `
    import assert from 'node:assert/strict';
    import plugin from 'opencode-quartermaster';
    import { QUARTERMASTER_RPC, requestSelection } from 'opencode-quartermaster/rpc';
    assert.equal(plugin.id, 'quartermaster');
    assert.equal(QUARTERMASTER_RPC.id, 'quartermaster');
    assert.equal(typeof requestSelection, 'function');
    const { readProjectQuartermasterOptions } = await import('./node_modules/opencode-quartermaster/dist/project-options.js');
    const { readFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const options = { plans: { check: ['fake/model'] }, agents: { reviewer: 'check' } };
    await writeFile('opencode.json', JSON.stringify({ plugins: [{ package: 'opencode-quartermaster@0.1.0' }] }));
    await writeFile('quartermaster.jsonc', JSON.stringify(options));
    const sources = async directory => [{ type: 'document', path: join(directory, 'opencode.json'), info: JSON.parse(await readFile(join(directory, 'opencode.json'), 'utf8')) }];
    assert.deepEqual((await readProjectQuartermasterOptions(process.cwd(), sources)).options, options);
    console.log('Installed root/RPC imports and versioned project-options recognition passed');
  `
  console.log(run(process.execPath, ["--input-type=module", "--eval", smoke], project).trim())
  await writeFile(join(project, "consumer.ts"), `
    import plugin from 'opencode-quartermaster';
    import { QUARTERMASTER_API_VERSION, requestSelection } from 'opencode-quartermaster/rpc';
    import type { Context } from '@opencode/plugin/promise/plugin';
    const apiVersion: 1 = QUARTERMASTER_API_VERSION;
    const setup: typeof plugin.setup = async (ctx: Context) => {
      await requestSelection(ctx, { agent: 'reviewer' });
    };
    // @ts-expect-error Version is a literal, not any.
    const wrong: 2 = QUARTERMASTER_API_VERSION;
  `)
  run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--strict",
    "--skipLibCheck", "--module", "NodeNext", "--target", "ES2022", "consumer.ts"], project)
  const previousArchive = option("previous-archive")
  const transitions = []
  if (previousArchive) {
    const configPath = join(project, "opencode.json")
    const configBefore = await readFile(configPath, "utf8")
    const sentinel = join(project, "user-notes.txt")
    await writeFile(sentinel, "Unrelated project work must survive install/update/rollback\n")
    const currentEntry = await readFile(join(installed, "dist", "agent-routing.js"))
    for (const [step, input] of [["previous", resolve(previousArchive)], ["update", archive], ["rollback", resolve(previousArchive)], ["restore-current", archive]]) {
      // Private development archives may share a version; this is not a published-version upgrade proof.
      run(process.execPath, [npmCLI, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", input], project, 300_000)
      assert.equal(await readFile(configPath, "utf8"), configBefore)
      assert.equal(await readFile(sentinel, "utf8"), "Unrelated project work must survive install/update/rollback\n")
      transitions.push({ step, sha256: createHash("sha256").update(await readFile(input)).digest("hex"), configUnchanged: true, unrelatedFileUnchanged: true })
    }
    assert.deepEqual(await readFile(join(installed, "dist", "agent-routing.js")), currentEntry)
  }
  const executable = option("executable") ?? join(homedir(), ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode")
  const trace = run(process.execPath, [join(root, "scripts", "verify-admission-host-contract.mjs"), installed, executable], project).trim()
  console.log(trace)
  const hostVersion = trace.match(/^Admission trace passed on OpenCode (\d+\.\d+\.\d+):/m)?.[1]
  assert.ok(hostVersion, "Host evidence must identify the tested version")
  const evidence = { package: metadata.name, version: metadata.version, archive, sha256, files: paths, node: process.version,
    platform: process.platform, arch: process.arch, transitions,
    pluginSDK: "2.0.23", host: `OpenCode ${hostVersion} isolated loopback; not OpenChamber-managed proof`, installed, project }
  const evidencePath = join(temp, "package-verification.json")
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ archive, sha256, files: paths.length, node: process.version, project, installed, evidencePath }, null, 2))
} catch (error) {
  console.error(`Package fixture retained: ${temp}`)
  throw error
}
