import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { readRequestBody } from '../e2e/desktop/modules/response-protocol.mjs'

for (const [encoding, compress] of [
  ['identity', value => value],
  ['gzip', gzipSync],
  ['zstd', zstdCompressSync],
]) {
  test(`decodes real Codex ${encoding} model requests`, async () => {
    const payload = { model: 'gpt-5.5', input: [{ role: 'user', content: '配置重载验证' }] }
    const request = Readable.from([compress(Buffer.from(JSON.stringify(payload)))])
    request.headers = { 'content-encoding': encoding }
    const parsed = readRequestBody(request)
    assert.equal(readRequestBody(request), parsed, 'Repeated readers must share the body promise')
    assert.deepEqual(await parsed, payload)
  })
}

test('rejects malformed zstd instead of returning an empty request', async () => {
  const request = Readable.from([Buffer.from('invalid compressed request')])
  request.headers = { 'content-encoding': 'zstd' }
  await assert.rejects(readRequestBody(request))
})
