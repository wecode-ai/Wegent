import { createHash, randomUUID } from 'node:crypto'
import {
  CLOUD_DEVICE_ID,
  DEFAULT_STEP_TIMEOUT_MS,
  assert,
  fetchJson,
  join,
  rm,
  writeFile,
} from './shared.mjs'

// Real cloud file protocol regression; this does not exercise native mobile UI.
export async function verifyCloudFileChunkIntegrity({ cloudEnvironment, workspacePath }) {
  const chunkBytes = 512 * 1024
  const name = `cloud-file-chunk-integrity-${randomUUID()}.bin`
  const filePath = join(workspacePath, name)
  const expected = Buffer.alloc(chunkBytes + 137)
  for (let index = 0; index < expected.length; index += 1) {
    expected[index] = (index * 31 + Math.floor(index / 251)) % 256
  }
  const receivedHash = createHash('sha256')
  const signal = AbortSignal.timeout(DEFAULT_STEP_TIMEOUT_MS)
  let receivedBytes = 0
  try {
    await writeFile(filePath, expected, { flag: 'wx' })
    for (const offset of [0, chunkBytes]) {
      const response = await fetchJson(
        `${cloudEnvironment.backendUrl}/api/devices/${encodeURIComponent(CLOUD_DEVICE_ID)}/commands`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cloudEnvironment.authToken}`,
            'Content-Type': 'application/json',
          },
          signal,
          body: JSON.stringify({
            command_key: 'workspace_read_file_chunk',
            path: workspacePath,
            args: [name, String(offset)],
            timeout_seconds: 15,
            max_output_bytes: 2 * 1024 * 1024,
          }),
        }
      )
      assert.equal(response.success, true, `Cloud file chunk failed at offset ${offset}`)
      const chunk = response.stdout
      assert.equal(chunk.name, name)
      assert.equal(chunk.offset, offset)
      assert.equal(chunk.size, expected.length)
      assert.equal(chunk.eof, offset === chunkBytes)
      assert.equal(typeof chunk.content_base64, 'string')
      const bytes = Buffer.from(chunk.content_base64, 'base64')
      assert.deepEqual(bytes, expected.subarray(offset, offset + chunkBytes))
      receivedBytes += bytes.length
      receivedHash.update(bytes)
    }
    assert.equal(receivedBytes, expected.length, 'The complete cloud file was not downloaded')
    assert.equal(receivedHash.digest('hex'), createHash('sha256').update(expected).digest('hex'))
  } finally {
    await rm(filePath, { force: true })
  }
}
