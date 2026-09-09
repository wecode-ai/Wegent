import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LocalPluginObjectStorage } from '../e2e/desktop/modules/local-plugin-object-storage.mjs'

test('multipart completion preserves part order and rejects invalid receipts', async t => {
  const storage = new LocalPluginObjectStorage()
  await storage.start()
  t.after(() => storage.stop())
  const object = `${storage.endpoint}/plugins/package.zip`
  const start = await fetch(`${object}?uploads`, { method: 'POST' }).then(r => r.text())
  const id = start.match(/<UploadId>(.*?)<\/UploadId>/)[1]
  const pieces = [Buffer.alloc(5 * 1024 * 1024, 65), Buffer.from('last part')]
  const etags = []
  for (const index of [1, 0]) {
    const response = await fetch(`${object}?uploadId=${id}&partNumber=${index + 1}`, {
      method: 'PUT',
      body: pieces[index],
    })
    assert.equal(response.status, 200)
    etags[index] = response.headers.get('etag')
  }
  const finish = etags =>
    fetch(`${object}?uploadId=${id}`, {
      method: 'POST',
      body: `<CompleteMultipartUpload>${etags
        .map(
          (etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag></Part>`
        )
        .join('')}</CompleteMultipartUpload>`,
    })
  assert.equal((await finish(['wrong'])).status, 400)
  assert.equal((await fetch(object)).status, 404)
  assert.equal((await finish(etags)).status, 200)
  assert.deepEqual(
    Buffer.from(await fetch(object).then(r => r.arrayBuffer())),
    Buffer.concat(pieces)
  )
  assert.equal(storage.uploads.size, 0)
})

test('aborting a multipart upload removes its parts without publishing an object', async t => {
  const storage = new LocalPluginObjectStorage()
  await storage.start()
  t.after(() => storage.stop())
  const object = `${storage.endpoint}/plugins/package.zip`
  const start = await fetch(`${object}?uploads`, { method: 'POST' }).then(r => r.text())
  const id = start.match(/<UploadId>(.*?)<\/UploadId>/)[1]
  assert.equal((await fetch(`${object}?uploadId=${id}`, { method: 'DELETE' })).status, 204)
  assert.equal(storage.uploads.size, 0)
  assert.equal((await fetch(object)).status, 404)
})
