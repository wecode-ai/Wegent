import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { WeworkSync, portablePreferences, resolveApiBaseUrl } from './index.js'
import { MemorySyncOutbox } from './outbox.js'

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')

function turn(overrides = {}) {
  return {
    transcriptId: 'task-1',
    taskId: 'task-1',
    title: 'Task',
    sequence: 1,
    turnId: 'turn-1',
    sessionId: 'session-1',
    ...overrides,
  }
}

function state() {
  return {
    value: { version: 4, enabled: true, transcripts: {}, preferencesHash: null },
    async save() {},
  }
}

async function segmentSource() {
  const directory = await mkdtemp(join(tmpdir(), 'segment-source-'))
  return {
    calls: [],
    async read(locator, options) {
      this.calls.push({ locator: structuredClone(locator), options })
      const path = join(directory, `${locator.turnId}.tgz`)
      await writeFile(path, 'native-codex-state')
      return {
        ...locator,
        path,
        sha256: 'a'.repeat(64),
        sizeBytes: 18,
        format: options.snapshot
          ? 'codex-snapshot.v1.tgz.aes256gcm'
          : 'codex-delta.v1.tgz.aes256gcm',
        rolloutEnd: 2048,
        summary: {
          userMessages: [{ id: 'user-1', text: 'Continue' }],
          assistantMessage: 'Done',
          reasoning: 'Checked',
          completion: { kind: 'completed' },
        },
      }
    },
  }
}

test('resolves backend API and strips device-local preferences', () => {
  assert.equal(
    resolveApiBaseUrl({ WEWORK_BACKEND_URL: 'https://cloud.example.com/api/v1' }),
    'https://cloud.example.com/api'
  )
  assert.deepEqual(
    portablePreferences({
      appearanceMode: 'dark',
      cloudConnection: { token: 'secret' },
      quickPhrases: [{ id: 'x', content: 'x', attachmentPaths: ['/private'] }],
    }),
    {
      appearanceMode: 'dark',
      quickPhrases: [{ id: 'x', content: 'x' }],
    }
  )
})

test('uploads a native snapshot and persists only its locator', async () => {
  const requests = []
  const uploads = []
  const source = await segmentSource()
  const outbox = new MemorySyncOutbox()
  const acknowledgements = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal)
    const chunks = []
    for await (const chunk of options.body) chunks.push(chunk)
    uploads.push(Buffer.concat(chunks).toString())
    return new Response(null, { status: 200 })
  }
  try {
    const sync = new WeworkSync({
      apiBaseUrl: 'https://cloud.example.com/api',
      clientId: 'client-1',
      outbox,
      source,
      state: state(),
      target: {
        async acknowledge(value) {
          acknowledgements.push(value)
        },
      },
      desktop: {
        weworkSync: {
          async request(request) {
            requests.push(request)
            if (request.path.endsWith('/lease')) {
              return { status: 200, body: { fencingToken: 7, currentSequence: 0 } }
            }
            if (request.path.endsWith('/encryption-key')) {
              return {
                status: 200,
                body: { algorithm: 'aes-256-gcm', key: TEST_ENCRYPTION_KEY },
              }
            }
            if (request.path.endsWith('/segments/prepare')) {
              return { status: 200, body: { uploadUrl: 'https://storage/upload' } }
            }
            return { status: 200, body: { currentSequence: 1, appended: 1 } }
          },
        },
      },
    })
    await sync.enqueue(turn())
    assert.equal(Object.hasOwn(outbox.first(), 'payload'), false)
    await sync.flushPending()
    assert.equal(outbox.count(), 0)
    assert.deepEqual(uploads, ['native-codex-state'])
    assert.equal(source.calls.at(-1).options.snapshot, true)
    assert.equal(acknowledgements[0].rolloutEnd, 2048)
    assert.ok(requests.some(request => request.path.endsWith('/segments/prepare')))
    const prepare = requests.find(request => request.path.endsWith('/segments/prepare'))
    const commit = requests.find(request => request.path.endsWith('/segments'))
    assert.equal(Object.hasOwn(prepare.body, 'summary'), false)
    assert.equal(commit.body.turnId, 'turn-1')
    assert.deepEqual(commit.body.summary, {
      userMessages: [{ id: 'user-1', text: 'Continue' }],
      assistantMessage: 'Done',
      reasoning: 'Checked',
      completion: { kind: 'completed' },
      taskId: 'task-1',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('restores the latest snapshot and contiguous native deltas', async () => {
  const restored = []
  const downloadSignals = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    downloadSignals.push(options.signal)
    return new Response(`object:${url}`, { status: 200 })
  }
  try {
    const sync = new WeworkSync({
      apiBaseUrl: 'https://cloud.example.com/api',
      clientId: 'client-2',
      outbox: new MemorySyncOutbox(),
      source: await segmentSource(),
      state: state(),
      target: {
        async status() {
          return { available: true, importedThrough: 0 }
        },
        async restore(transcript, segments, options) {
          restored.push({
            transcript,
            options,
            segments: await Promise.all(
              segments.map(async segment => ({
                ...segment,
                body: await readFile(segment.path, 'utf8'),
              }))
            ),
          })
          return { available: true, importedThrough: 2 }
        },
      },
      desktop: {
        weworkSync: {
          async request(request) {
            if (request.path === '/wework-transcripts?includeArchived=true') {
              return {
                status: 200,
                body: {
                  items: [
                    {
                      transcriptId: 'shared',
                      currentSequence: 2,
                      archives: [
                        {
                          id: 0,
                          fromSequence: 0,
                          toSequence: 0,
                          sha256: '0'.repeat(64),
                          sizeBytes: 32,
                          format: 'jsonl.zst',
                        },
                        {
                          id: 1,
                          fromSequence: 0,
                          toSequence: 1,
                          sha256: 'a'.repeat(64),
                          sizeBytes: 32,
                          format: 'codex-snapshot.v1.tgz.aes256gcm',
                        },
                        {
                          id: 2,
                          fromSequence: 2,
                          toSequence: 2,
                          sha256: 'b'.repeat(64),
                          sizeBytes: 32,
                          format: 'codex-delta.v1.tgz.aes256gcm',
                        },
                      ],
                    },
                  ],
                },
              }
            }
            if (request.path.endsWith('/encryption-key')) {
              return {
                status: 200,
                body: { algorithm: 'aes-256-gcm', key: TEST_ENCRYPTION_KEY },
              }
            }
            const id = request.path.match(/archives\/(\d+)\/download/u)?.[1]
            return { status: 200, body: { downloadUrl: `https://storage/${id}` } }
          },
        },
      },
    })
    await sync.pullTranscripts()
    assert.equal(restored.length, 1)
    assert.deepEqual(
      restored[0].segments.map(segment => segment.sequence),
      [1, 2]
    )
    assert.equal(restored[0].segments[1].body, 'object:https://storage/2')
    assert.equal(restored[0].options.encryptionKey, TEST_ENCRYPTION_KEY)
    assert.equal(downloadSignals.length, 2)
    assert.ok(downloadSignals.every(signal => signal instanceof AbortSignal))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('branches deterministically when the cloud causal head changed', async () => {
  const source = await segmentSource()
  const pending = turn({
    transcriptId: 'shared',
    taskId: 'local-task',
    sequence: 2,
    turnId: 'turn-b',
    baseSequence: 1,
    cloudSequence: 2,
  })
  const outbox = new MemorySyncOutbox([pending])
  const leases = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    for await (const _chunk of options.body) {
      // Consume the stream before the temporary segment is removed.
    }
    return new Response(null, { status: 200 })
  }
  try {
    const sync = new WeworkSync({
      apiBaseUrl: 'https://cloud.example.com/api',
      clientId: 'device-b',
      outbox,
      source,
      state: state(),
      target: { async acknowledge() {} },
      desktop: {
        weworkSync: {
          async request(request) {
            if (request.path.endsWith('/lease')) {
              leases.push(request)
              return {
                status: 200,
                body: {
                  fencingToken: 9,
                  currentSequence: request.path.includes('/shared/') ? 2 : 0,
                },
              }
            }
            if (request.path.endsWith('/encryption-key')) {
              return {
                status: 200,
                body: { algorithm: 'aes-256-gcm', key: TEST_ENCRYPTION_KEY },
              }
            }
            if (request.path.endsWith('/segments/prepare')) {
              return { status: 200, body: { uploadUrl: 'https://storage/upload' } }
            }
            return { status: 200, body: {} }
          },
        },
      },
    })
    await sync.flushPending()
    assert.equal(outbox.count(), 0)
    const branchLease = leases.find(request => request.path.includes('/fork-'))
    assert.equal(branchLease.body.parentTranscriptId, 'shared')
    assert.equal(branchLease.body.forkedAtSequence, 1)
    assert.equal(source.calls.at(-1).options.snapshot, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})
