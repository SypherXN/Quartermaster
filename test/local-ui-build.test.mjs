import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { once } from "node:events"
import test from "node:test"
import { fileURLToPath } from "node:url"

test("the built local UI imports and serves its page without source .ts files", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], { cwd: root })
  const { createLocalUiServer } = await import("../dist/local-ui.mjs")
  // Fake credentials: this check only serves HTML; it never calls OpenCode.
  const server = createLocalUiServer({
    openCodeURL: "http://127.0.0.1:1", token: "test-only",
    projectDirectory: root, port: 0,
  })
  try {
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /Quartermaster/)
  } finally {
    await new Promise((done) => server.close(done))
  }
})
