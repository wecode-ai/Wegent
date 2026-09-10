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
    async summarize(locator) {
      return {
        ...locator,
        payload: {
          userMessages: [{ id: 'user-1', text: 'Continue' }],
          assistantMessage: 'Done',
          reasoning: 'Checked',
          completion: { kind: 'completed' },
        },
      }
    },
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
        summary: options.summary,
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

test('prefers the active cloud connection over the environment backend', async () => {
  const sync = new WeworkSync({
    apiBaseUrl: 'http://127.0.0.1:9100/api',
    clientId: 'client-1',
    outbox: new MemorySyncOutbox(),
    source: await segmentSource(),
    state: state(),
    target: {},
    desktop: {
      preferences: {
        async get() {
          return {
            cloudConnection: {
              apiBaseUrl: 'https://preview.example.com/api',
            },
          }
        },
      },
    },
  })

  assert.equal(await sync.ensureApiBaseUrl(), true)
  assert.equal(sync.apiBaseUrl, 'https://preview.example.com/api')
})

test('uploads a native snapshot and persists only its locator', async () => {
  const requests = []
  const source = await segmentSource()
  const outbox = new MemorySyncOutbox()
  const acknowledgements = []
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
          if (request.file) {
            request.fileContent = await readFile(request.file.path, 'utf8')
          }
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
          return { status: 200, body: { currentSequence: 1, appended: 1 } }
        },
      },
    },
  })
  await sync.enqueue(turn())
  assert.equal(Object.hasOwn(outbox.first(), 'payload'), false)
  await sync.flushPending()
  assert.equal(outbox.count(), 0)
  assert.equal(source.calls.at(-1).options.snapshot, true)
  assert.equal(acknowledgements[0].rolloutEnd, 2048)
  assert.equal(
    requests.some(request => request.path.endsWith('/segments/prepare')),
    false
  )
  const upload = requests.find(request => request.path.endsWith('/segments'))
  assert.equal(upload.body.turnId, 'turn-1')
  assert.deepEqual(upload.body.summary, {
    userMessages: [{ id: 'user-1', text: 'Continue' }],
    assistantMessage: 'Done',
    reasoning: 'Checked',
    completion: { kind: 'completed' },
    taskId: 'task-1',
  })
  assert.equal(upload.file.name, 'segment.tgz.aes256gcm')
  assert.equal(upload.file.contentType, 'application/octet-stream')
  assert.equal(upload.fileContent, 'native-codex-state')
})

test('restores the latest snapshot and contiguous native deltas', async () => {
  const restored = []
  const downloadPaths = []
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
          assert.ok(request.downloadPath)
          downloadPaths.push(request.downloadPath)
          await writeFile(request.downloadPath, `object:${id}`)
          return { status: 200, body: { path: request.downloadPath } }
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
  assert.equal(restored[0].segments[1].body, 'object:2')
  assert.equal(restored[0].options.encryptionKey, TEST_ENCRYPTION_KEY)
  assert.equal(downloadPaths.length, 2)
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
})

test('discards an orphaned session and continues uploading healthy sessions', async () => {
  const source = await segmentSource()
  const summarize = source.summarize.bind(source)
  source.summarize = async locator => {
    if (locator.sessionId === 'orphaned-session') {
      throw Object.assign(new Error('runtime task is unavailable'), {
        code: 'transcript_task_missing',
      })
    }
    return summarize(locator)
  }
  const outbox = new MemorySyncOutbox([
    turn({
      transcriptId: 'orphaned',
      taskId: 'orphaned',
      turnId: 'orphaned-turn-1',
      sessionId: 'orphaned-session',
    }),
    turn({
      transcriptId: 'orphaned',
      taskId: 'orphaned',
      sequence: 2,
      turnId: 'orphaned-turn-2',
      sessionId: 'orphaned-session',
      baseSequence: 1,
    }),
    turn({
      transcriptId: 'healthy',
      taskId: 'healthy',
      turnId: 'healthy-turn',
      sessionId: 'healthy-session',
    }),
  ])
  const requests = []
  const sync = new WeworkSync({
    apiBaseUrl: 'https://cloud.example.com/api',
    clientId: 'client-1',
    outbox,
    source,
    state: state(),
    target: { async acknowledge() {} },
    desktop: {
      weworkSync: {
        async request(request) {
          requests.push(request)
          if (request.path.endsWith('/lease')) {
            return { status: 200, body: { fencingToken: 1, currentSequence: 0 } }
          }
          if (request.path.endsWith('/encryption-key')) {
            return {
              status: 200,
              body: { algorithm: 'aes-256-gcm', key: TEST_ENCRYPTION_KEY },
            }
          }
          return { status: 200, body: {} }
        },
      },
    },
  })

  await sync.flushPending()

  assert.equal(outbox.count(), 0)
  assert.equal(
    requests.some(request => request.path.includes('/orphaned/')),
    false
  )
  assert.ok(requests.some(request => request.path.includes('/healthy/')))
})

test('isolates a missing turn while other sessions continue uploading', async () => {
  const source = await segmentSource()
  const summarize = source.summarize.bind(source)
  source.summarize = async locator => {
    if (locator.sessionId === 'blocked-session') {
      throw Object.assign(new Error('executor turn is unavailable'), {
        code: 'transcript_turn_missing',
      })
    }
    return summarize(locator)
  }
  const blocked = turn({
    transcriptId: 'blocked',
    taskId: 'blocked',
    turnId: 'blocked-turn',
    sessionId: 'blocked-session',
  })
  const outbox = new MemorySyncOutbox([
    blocked,
    turn({
      transcriptId: 'healthy',
      taskId: 'healthy',
      turnId: 'healthy-turn',
      sessionId: 'healthy-session',
    }),
  ])
  const sync = new WeworkSync({
    apiBaseUrl: 'https://cloud.example.com/api',
    clientId: 'client-1',
    outbox,
    source,
    state: state(),
    target: { async acknowledge() {} },
    desktop: {
      weworkSync: {
        async request(request) {
          if (request.path.endsWith('/lease')) {
            return { status: 200, body: { fencingToken: 1, currentSequence: 0 } }
          }
          if (request.path.endsWith('/encryption-key')) {
            return {
              status: 200,
              body: { algorithm: 'aes-256-gcm', key: TEST_ENCRYPTION_KEY },
            }
          }
          return { status: 200, body: {} }
        },
      },
    },
  })

  await assert.rejects(sync.flushPending(), error => error.code === 'transcript_turn_missing')

  assert.equal(outbox.count(), 1)
  assert.equal(outbox.first().turnId, blocked.turnId)
})

test('continues download and preference phases after an upload phase failure', async () => {
  const sync = new WeworkSync({
    apiBaseUrl: 'https://cloud.example.com/api',
    clientId: 'client-1',
    outbox: new MemorySyncOutbox(),
    source: await segmentSource(),
    state: state(),
    target: {},
    desktop: {},
  })
  const phases = []
  sync.flushPending = async () => {
    phases.push('upload')
    throw new Error('upload failed')
  }
  sync.pullTranscripts = async () => {
    phases.push('download')
  }
  sync.syncPreferences = async () => {
    phases.push('preferences')
  }

  await assert.rejects(sync.flush(), /upload failed/u)
  assert.deepEqual(phases, ['upload', 'download', 'preferences'])
})

test('clears the previous synchronization error after a successful retry', async () => {
  const sync = new WeworkSync({
    apiBaseUrl: 'https://cloud.example.com/api',
    clientId: 'client-1',
    outbox: new MemorySyncOutbox(),
    source: await segmentSource(),
    state: state(),
    target: {},
    desktop: {},
  })
  let fail = true
  sync.flushPending = async () => {
    if (fail) throw new Error('temporary upload failure')
  }
  sync.pullTranscripts = async () => {}
  sync.syncPreferences = async () => {}

  await assert.rejects(sync.flush(), /temporary upload failure/u)
  assert.equal(sync.service().status().lastError, 'temporary upload failure')

  fail = false
  await sync.flush()

  const status = sync.service().status()
  assert.equal(status.lastError, null)
  assert.equal(typeof status.lastSuccessAt, 'string')
})

test('does not restore over a transcript with an unresolved local turn', async () => {
  const outbox = new MemorySyncOutbox([
    turn({
      transcriptId: 'shared',
      taskId: 'local-task',
      sequence: 2,
      turnId: 'local-conflict',
      baseSequence: 1,
      cloudSequence: 2,
    }),
  ])
  const restored = []
  const inspected = []
  const sync = new WeworkSync({
    apiBaseUrl: 'https://cloud.example.com/api',
    clientId: 'device-b',
    outbox,
    source: await segmentSource(),
    state: state(),
    target: {
      async status(transcript) {
        inspected.push(transcript.transcriptId)
        return { available: true, importedThrough: 1 }
      },
      async restore(transcript) {
        restored.push(transcript.transcriptId)
        return { available: true, importedThrough: transcript.currentSequence }
      },
    },
    desktop: {
      weworkSync: {
        async request(request) {
          assert.equal(request.path, '/wework-transcripts?includeArchived=true')
          return {
            status: 200,
            body: {
              items: [
                {
                  transcriptId: 'shared',
                  currentSequence: 2,
                  archives: [
                    {
                      id: 2,
                      fromSequence: 0,
                      toSequence: 2,
                      sha256: 'a'.repeat(64),
                      sizeBytes: 32,
                      format: 'codex-snapshot.v1.tgz.aes256gcm',
                    },
                  ],
                },
                {
                  transcriptId: 'unrelated',
                  currentSequence: 0,
                  archives: [],
                },
              ],
            },
          }
        },
      },
    },
  })

  await sync.pullTranscripts()

  assert.deepEqual(inspected, ['unrelated'])
  assert.deepEqual(restored, [])
  assert.equal(sync.state.value.transcripts.shared.currentSequence, 2)
})
