import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('serves real static assets and preserves HEAD, redirect and unavailable responses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-app-assets-'))
  const previousRoot = process.env.WEWORK_APP_WEB_ROOT
  let server
  try {
    process.env.WEWORK_APP_WEB_ROOT = directory
    const { serveWeworkApp } = await import(`./index.js?assets=${Date.now()}`)
    if (previousRoot === undefined) delete process.env.WEWORK_APP_WEB_ROOT
    else process.env.WEWORK_APP_WEB_ROOT = previousRoot
    const body = 'export const ready = true\n'
    await writeFile(join(directory, 'app.js'), body)
    await writeFile(join(directory, 'index.html'), '<html></html>')
    server = createServer((req, res) => {
      void serveWeworkApp(req, res).catch(error => {
        res.destroy(error)
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = `http://127.0.0.1:${server.address().port}/wework/app`
    const asset = await fetch(`${base}/app.js`)
    assert.equal(asset.status, 200)
    assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(Number(asset.headers.get('content-length')), Buffer.byteLength(body))
    assert.equal(await asset.text(), body)
    const head = await fetch(`${base}/app.js`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(body))
    assert.equal(await head.text(), '')
    for (const path of ['/', '/missing', '/index.html']) {
      const redirect = await fetch(`${base}${path}`, { redirect: 'manual' })
      assert.equal(redirect.status, 302)
      assert.match(redirect.headers.get('location'), /^\/\?__wework_route=/)
      await redirect.text()
    }
    await rm(join(directory, 'index.html'))
    const unavailable = await fetch(`${base}/missing`)
    assert.equal(unavailable.status, 503)
    assert.equal(await unavailable.text(), 'Wework DSH application assets are unavailable')
    // An existing asset does not depend on the HTML entry being present.
    const remainingAsset = await fetch(`${base}/app.js`)
    assert.equal(remainingAsset.status, 200)
    assert.equal(await remainingAsset.text(), body)
  } finally {
    if (previousRoot === undefined) delete process.env.WEWORK_APP_WEB_ROOT
    else process.env.WEWORK_APP_WEB_ROOT = previousRoot
    if (server) await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
