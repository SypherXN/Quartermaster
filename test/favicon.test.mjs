import assert from "node:assert/strict"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { createLocalUiServer } from "../src/local-ui.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))

test("the page favicon decodes to the brand chest glyph in brand colors", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8")
  const link = html.match(/<link rel="icon"[^>]*href="([^"]+)"/)
  assert.ok(link, "index.html declares a favicon link")
  const uri = link[1]
  assert.ok(uri.startsWith("data:image/svg+xml,"), "favicon is an inline SVG data URI")
  const svg = decodeURIComponent(uri.slice("data:image/svg+xml,".length))
  assert.match(svg, /viewBox='0 0 24 24'/)
  assert.match(svg, /<rect x='3' y='6' width='18' height='14' rx='1\.5'\/>/)
  assert.match(svg, /d='M3 10h7m4 0h7M10 6v8h4V6'/)
  assert.match(svg, /fill='#b39250'/, "brand plate background")
  assert.match(svg, /stroke='#26311f'/, "brand glyph color")
  assert.match(svg, /stroke-width='1\.7'/)
})

test("the local gateway CSP allows the inline data-URI favicon image", async () => {
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
    const csp = response.headers.get("content-security-policy")
    assert.ok(csp, "page response carries a CSP header")
    assert.match(csp, /img-src[^;]*'self'/)
    assert.match(csp, /img-src[^;]*data:/)
  } finally {
    await new Promise((done) => server.close(done))
  }
})
