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

test('reuploads the same native segment when its commit was already recorded', async () => {
  const source = await segmentSource()
  const pending = turn({
    transcriptId: 'shared',
    taskId: 'shared',
    baseSequence: 0,
    cloudSequence: 1,
  })
  const outbox = new MemorySyncOutbox([pending])
  const requests = []
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
            return { status: 200, body: { fencingToken: 2, currentSequence: 1 } }
          }
          if (request.path.endsWith('/encryption-key')) {
            return {
              status: 200,
              body: { algorithm: 'aes-256-gcm', key: TEST_ENCRYPTION_KEY },
            }
          }
          if (request.path.endsWith('/segments')) {
            return { status: 200, body: { currentSequence: 1, appended: 0 } }
          }
          return { status: 200, body: { released: true } }
        },
      },
    },
  })

  await sync.flushPending()

  assert.equal(outbox.count(), 0)
  assert.equal(acknowledgements.length, 1)
  const upload = requests.find(request => request.path.endsWith('/segments'))
  assert.equal(upload.body.turnId, pending.turnId)
  assert.equal(upload.body.sequence, 1)
  assert.equal(upload.fileContent, 'native-codex-state')
  assert.equal(
    requests.some(
      request =>
        request.path === '/wework-transcripts/shared' ||
        request.path.startsWith('/wework-transcripts/shared/turns')
    ),
    false
  )
})

test('retries a pending delta as a snapshot when the cloud recovery chain is missing', async () => {
  const source = await segmentSource()
  const pending = turn({
    sequence: 2,
    turnId: 'turn-2',
    baseSequence: 1,
    cloudSequence: 2,
  })
  const outbox = new MemorySyncOutbox([pending])
  const uploads = []
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
            return { status: 200, body: { fencingToken: 3, currentSequence: 1 } }
          }
          if (request.path.endsWith('/encryption-key')) {
            return {
              status: 200,
              body: { algorithm: 'aes-256-gcm', key: TEST_ENCRYPTION_KEY },
            }
          }
          if (request.path.endsWith('/segments')) {
            uploads.push(structuredClone(request.body))
            if (uploads.length === 1) {
              return {
                status: 409,
                body: {
                  detail: {
                    code: 'snapshot_required',
                    message: 'The cloud transcript recovery chain is incomplete',
                  },
                },
              }
            }
            return { status: 200, body: { currentSequence: 2, appended: 1 } }
          }
          return { status: 200, body: { released: true } }
        },
      },
    },
  })

  await sync.flushPending()

  assert.equal(outbox.count(), 0)
  assert.equal(uploads.length, 2)
  assert.equal(uploads[0].format, 'codex-delta.v1.tgz.aes256gcm')
  assert.equal(uploads[1].format, 'codex-snapshot.v1.tgz.aes256gcm')
  assert.deepEqual(
    source.calls.map(call => call.options.snapshot),
    [false, true]
  )
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
        return { available: true, importedThrough: 0, reason: 'restore_required' }
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
          if (request.path === '/wework-transcripts?includeArchived=false') {
            return {
              status: 200,
              body: {
                items: [
                  {
                    transcriptId: 'shared',
                    writerClientId: 'client-1',
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

test('skips a missing cloud archive and continues restoring other transcripts', async () => {
  const restored = []
  const sync = new WeworkSync({
    apiBaseUrl: 'https://cloud.example.com/api',
    clientId: 'client-2',
    outbox: new MemorySyncOutbox(),
    source: await segmentSource(),
    state: state(),
    target: {
      async status() {
        return { available: true, importedThrough: 0, reason: 'restore_required' }
      },
      async restore(transcript) {
        restored.push(transcript.transcriptId)
        return { available: true, importedThrough: transcript.currentSequence }
      },
    },
    desktop: {
      weworkSync: {
        async request(request) {
          if (request.path === '/wework-transcripts?includeArchived=false') {
            return {
              status: 200,
              body: {
                items: ['missing', 'available'].map((transcriptId, index) => ({
                  transcriptId,
                  currentSequence: 1,
                  archives: [
                    {
                      id: index + 1,
                      fromSequence: 0,
                      toSequence: 1,
                      sha256: 'a'.repeat(64),
                      sizeBytes: 32,
                      format: 'codex-snapshot.v1.tgz.aes256gcm',
                    },
                  ],
                })),
              },
            }
          }
          if (request.path.endsWith('/encryption-key')) {
            return {
              status: 200,
              body: { algorithm: 'aes-256-gcm', key: TEST_ENCRYPTION_KEY },
            }
          }
          if (request.path.includes('/missing/')) {
            return {
              status: 404,
              body: {
                detail: {
                  code: 'archive_not_found',
                  message: 'Wework transcript segment not found',
                },
              },
            }
          }
          await writeFile(request.downloadPath, 'available')
          return { status: 200, body: { path: request.downloadPath } }
        },
      },
    },
  })

  await sync.pullTranscripts()

  assert.deepEqual(restored, ['available'])
  assert.equal(sync.state.value.transcripts.missing.downloadedThrough, 0)
  assert.equal(sync.state.value.transcripts.available.downloadedThrough, 1)
})

test('the most recent writer restores a missing parent after creating a conflict fork', async () => {
  const restored = []
  const sync = new WeworkSync({
    apiBaseUrl: 'https://cloud.example.com/api',
    clientId: 'client-2',
    outbox: new MemorySyncOutbox(),
    source: await segmentSource(),
    state: state(),
    target: {
      async status(transcript) {
        assert.equal(transcript.transcriptId, 'created-here')
        return { available: true, importedThrough: 0, reason: 'restore_required' }
      },
      async restore(transcript) {
        restored.push(transcript.transcriptId)
        return { available: true, importedThrough: transcript.currentSequence }
      },
    },
    desktop: {
      weworkSync: {
        async request(request) {
          if (request.path === '/wework-transcripts?includeArchived=false') {
            return {
              status: 200,
              body: {
                items: [
                  {
                    transcriptId: 'created-here',
                    writerClientId: 'client-2',
                    currentSequence: 1,
                    archives: [
                      {
                        id: 1,
                        fromSequence: 0,
                        toSequence: 1,
                        sha256: 'a'.repeat(64),
                        sizeBytes: 32,
                        format: 'codex-snapshot.v1.tgz.aes256gcm',
                      },
                    ],
                  },
                  {
                    transcriptId: 'fork-created-here',
                    parentTranscriptId: 'created-here',
                    writerClientId: 'client-2',
                    currentSequence: 1,
                    archives: [],
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
          assert.match(request.path, /\/archives\/1\/download$/u)
          await writeFile(request.downloadPath, 'fork')
          return { status: 200, body: { path: request.downloadPath } }
        },
      },
    },
  })

  await sync.pullTranscripts()

  assert.deepEqual(restored, ['created-here'])
  assert.equal(sync.state.value.transcripts['created-here'].downloadedThrough, 1)
  assert.equal(sync.state.value.transcripts['fork-created-here'].downloadedThrough, 0)
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
          if (request.path.includes('/shared/') && request.path.endsWith('/segments')) {
            return {
              status: 409,
              body: {
                detail: {
                  code: 'segment_conflict',
                  message: 'A different native segment already exists at this sequence',
                },
              },
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

test('branches from the available cloud head when the cached causal base is newer', async () => {
  const source = await segmentSource()
  const pending = turn({
    transcriptId: 'shared',
    taskId: 'local-task',
    sequence: 16,
    turnId: 'turn-b',
    baseSequence: 15,
    cloudSequence: 16,
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
                currentSequence: request.path.includes('/shared/') ? 11 : 0,
              },
            }
          }
          if (request.path.endsWith('/encryption-key')) {
            return {
              status: 200,
              body: { algorithm: 'aes-256-gcm', key: TEST_ENCRYPTION_KEY },
            }
          }
          if (request.path.includes('/shared/') && request.path.endsWith('/segments')) {
            return {
              status: 409,
              body: {
                detail: {
                  code: 'segment_conflict',
                  message: 'A different native segment already exists at this sequence',
                },
              },
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
  assert.equal(branchLease.body.forkedAtSequence, 11)
  assert.equal(source.calls.at(-1).options.snapshot, true)
})

test('skips every unavailable orphaned turn and continues uploading healthy sessions', async () => {
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

test('permanently skips a missing turn and continues the same session', async () => {
  const source = await segmentSource()
  const summarize = source.summarize.bind(source)
  source.summarize = async locator => {
    if (locator.turnId === 'missing-turn') {
      throw Object.assign(new Error('executor turn is unavailable'), {
        code: 'transcript_turn_missing',
      })
    }
    return summarize(locator)
  }
  const blocked = turn({
    transcriptId: 'shared',
    taskId: 'shared',
    turnId: 'missing-turn',
    sessionId: 'shared-session',
  })
  const outbox = new MemorySyncOutbox([
    blocked,
    turn({
      transcriptId: 'shared',
      taskId: 'shared',
      sequence: 2,
      turnId: 'later-turn',
      sessionId: 'shared-session',
      baseSequence: 1,
    }),
    turn({
      transcriptId: 'healthy',
      taskId: 'healthy',
      turnId: 'healthy-turn',
      sessionId: 'healthy-session',
    }),
  ])
  const uploadedTurns = []
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
          if (request.path.endsWith('/segments')) {
            uploadedTurns.push(request.body.turnId)
          }
          return { status: 200, body: {} }
        },
      },
    },
  })

  await sync.flushPending()

  assert.equal(outbox.count(), 0)
  assert.deepEqual(uploadedTurns, ['later-turn', 'healthy-turn'])
  await sync.enqueue(
    turn({
      transcriptId: 'shared',
      taskId: 'shared',
      turnId: 'missing-turn',
      sessionId: 'shared-session',
    })
  )
  assert.equal(outbox.count(), 0)
  await sync.enqueue(
    turn({
      transcriptId: 'shared',
      taskId: 'shared',
      sequence: 3,
      turnId: 'future-turn',
      sessionId: 'shared-session',
    })
  )
  assert.equal(outbox.count(), 1)
  await sync.flushPending()
  assert.deepEqual(uploadedTurns, ['later-turn', 'healthy-turn', 'future-turn'])
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

test('reports every failed synchronization phase in the status error', async () => {
  const sync = new WeworkSync({
    apiBaseUrl: 'https://cloud.example.com/api',
    clientId: 'client-1',
    outbox: new MemorySyncOutbox(),
    source: await segmentSource(),
    state: state(),
    target: {},
    desktop: {},
  })
  sync.flushPending = async () => {
    throw new Error('upload unavailable')
  }
  sync.pullTranscripts = async () => {
    throw new Error('download unavailable')
  }
  sync.syncPreferences = async () => {
    throw new Error('preferences unavailable')
  }

  await assert.rejects(
    sync.flush(),
    /Conversation upload: upload unavailable; Conversation download: download unavailable; Preference synchronization: preferences unavailable/u
  )
  assert.equal(
    sync.service().status().lastError,
    'Conversation upload: upload unavailable; Conversation download: download unavailable; Preference synchronization: preferences unavailable'
  )
})

test('preserves a failed sync result when synchronization is disabled between phases', async () => {
  const sync = new WeworkSync({
    apiBaseUrl: 'https://cloud.example.com/api',
    clientId: 'client-1',
    outbox: new MemorySyncOutbox(),
    source: await segmentSource(),
    state: state(),
    target: {},
    desktop: {},
  })
  sync.failureCount = 2
  sync.flushPending = async () => {
    sync.enabled = false
    throw new Error('upload failed before disable')
  }
  sync.pullTranscripts = async () => {
    assert.fail('Download must not run after synchronization is disabled')
  }
  sync.syncPreferences = async () => {
    assert.fail('Preferences must not run after synchronization is disabled')
  }

  await assert.rejects(sync.flush(), /upload failed before disable/u)

  const status = sync.service().status()
  assert.equal(status.lastError, 'upload failed before disable')
  assert.equal(status.lastSuccessAt, null)
  assert.equal(sync.failureCount, 3)
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
          assert.equal(request.path, '/wework-transcripts?includeArchived=false')
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
