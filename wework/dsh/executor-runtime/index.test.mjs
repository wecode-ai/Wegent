import assert from 'node:assert/strict'
import test from 'node:test'

import { createTranscriptTarget, exportExecutorTranscript } from './index.js'

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')

test('exports a native segment without materializing transcript text', async () => {
  const client = {
    async request(method, params) {
      assert.equal(method, 'runtime.tasks.transcript.export')
      assert.deepEqual(params, {
        transcriptId: 'transcript-1',
        taskId: 'task-1',
        baseSequence: 4,
        sequence: 5,
        snapshot: false,
        encryptionKey: TEST_ENCRYPTION_KEY,
      })
      return {
        path: '/tmp/segment.tgz.aes256gcm',
        sha256: 'a'.repeat(64),
        sizeBytes: 100,
        format: 'codex-rollout-delta.v1.tgz.aes256gcm',
        rolloutEnd: 2048,
      }
    },
  }
  const result = await exportExecutorTranscript(
    client,
    { transcriptId: 'transcript-1', taskId: 'task-1' },
    {
      baseSequence: 4,
      sequence: 5,
      snapshot: false,
      encryptionKey: TEST_ENCRYPTION_KEY,
    }
  )
  assert.equal(result.path, '/tmp/segment.tgz.aes256gcm')
  assert.equal(Object.hasOwn(result, 'payload'), false)
})

test('routes restore and acknowledgement through native transcript RPCs', async () => {
  const requests = []
  const client = {
    async request(method, params) {
      requests.push({ method, params })
      return { available: true, importedThrough: params.sequence ?? 2 }
    },
  }
  const target = createTranscriptTarget(client)
  const transcript = { transcriptId: 'shared', taskId: 'local-task' }
  const segments = [
    {
      path: '/tmp/1.tgz.aes256gcm',
      sha256: 'b'.repeat(64),
      sequence: 1,
      format: 'codex-rollout-snapshot.v1.tgz.aes256gcm',
    },
  ]
  await target.status(transcript)
  await target.restore(transcript, segments, { encryptionKey: TEST_ENCRYPTION_KEY })
  await target.acknowledge({
    ...transcript,
    cloudSequence: 2,
    rolloutEnd: 4096,
    parentTranscriptId: 'main',
  })
  assert.deepEqual(requests, [
    {
      method: 'runtime.tasks.transcript.sync_status',
      params: { transcriptId: 'shared', taskId: 'local-task' },
    },
    {
      method: 'runtime.tasks.transcript.restore',
      params: {
        transcriptId: 'shared',
        taskId: 'local-task',
        segments,
        encryptionKey: TEST_ENCRYPTION_KEY,
      },
    },
    {
      method: 'runtime.tasks.transcript.acknowledge',
      params: {
        transcriptId: 'shared',
        taskId: 'local-task',
        sequence: 2,
        rolloutEnd: 4096,
        parentTranscriptId: 'main',
      },
    },
  ])
})
