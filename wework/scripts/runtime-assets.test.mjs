import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { serveHarnessRuntimeAsset } from '../e2e/desktop/modules/runtime-assets.mjs'

test('returns a missing runtime as HTTP 404 and continues serving existing assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-runtime-http-'))
  const errors = []
  const server = createServer((request, response) => {
    void serveHarnessRuntimeAsset(
      request,
      response,
      new URL(request.url, 'http://localhost'),
      root
    ).catch(error => {
      errors.push(error)
      response.writeHead(500)
      response.end()
    })
  })
  try {
    await writeFile(join(root, 'existing.tar.gz'), 'runtime bytes')
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const missing = await fetch(`${origin}/dsh-runtime-assets/missing.tar.gz`)
    assert.equal(missing.status, 404)
    await missing.text()
    const existing = await fetch(`${origin}/dsh-runtime-assets/existing.tar.gz`)
    assert.equal(existing.status, 200)
    assert.equal(await existing.text(), 'runtime bytes')
    assert.deepEqual(errors, [])
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
