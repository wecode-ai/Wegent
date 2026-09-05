import assert from 'node:assert/strict'
import test from 'node:test'
import { WeworkSync, portablePreferences, resolveApiBaseUrl } from './index.js'
import { MemorySyncOutbox } from './outbox.js'

function createTurnSource(turns = []) {
  const payloads = new Map(turns.map(turn => [turn.turnId, structuredClone(turn.payload)]))
  return {
    add(turn) {
      payloads.set(turn.turnId, structuredClone(turn.payload))
    },
    read(turn) {
      const payload = payloads.get(turn.turnId)
      if (!payload) throw new Error(`Missing local turn: ${turn.turnId}`)
      return { ...turn, payload: structuredClone(payload) }
    },
  }
}

function completedTurn(overrides = {}) {
  return {
    transcriptId: 'task-1',
    taskId: 'task-1',
    title: 'Task',
    sequence: 1,
    turnId: 'task-1:1',
    sessionId: 'session-task-1',
    payload: { assistantMessage: 'Done' },
    ...overrides,
  }
}

test('resolves the backend API and excludes device-local preference data', () => {
  assert.equal(
    resolveApiBaseUrl({ WEWORK_BACKEND_URL: 'https://cloud.example.com/api/v1' }),
    'https://cloud.example.com/api'
  )
  assert.deepEqual(
    portablePreferences({
      appearanceMode: 'dark',
      cloudConnection: { token: 'secret' },
      localHarnesses: [{ id: 'local' }],
      quickPhrases: [
        {
          id: 'summary',
          title: 'Summary',
          content: 'Summarize',
          mode: 'normal',
          attachmentPaths: ['/private/file'],
        },
      ],
    }),
    {
      appearanceMode: 'dark',
      quickPhrases: [
        {
          id: 'summary',
          title: 'Summary',
          content: 'Summarize',
          mode: 'normal',
        },
      ],
    }
  )
})

test('persists only a finalized turn locator before uploading it with a writer lease', async () => {
  const requests = []
  const outbox = new MemorySyncOutbox()
  const source = createTurnSource()
  const state = {
    value: { version: 2, transcripts: {}, preferencesHash: null },
    saves: 0,
    async save() {
      this.saves += 1
    },
  }
  const desktop = {
    preferences: {
      async get() {
        return {}
      },
      async update() {},
    },
    weworkSync: {
      async request(request) {
        requests.push(request)
        if (request.path.endsWith('/lease')) {
          return { status: 200, body: { fencingToken: 7, currentSequence: 0 } }
        }
        return { status: 200, body: { currentSequence: 1, appended: 1 } }
      },
    },
  }
  const sync = new WeworkSync({
    apiBaseUrl: 'https://cloud.example.com/api',
    clientId: 'client-1',
    desktop,
    outbox,
    source,
    state,
  })
  const turn = completedTurn()
  source.add(turn)

  await sync.enqueue(turn)
  assert.equal(outbox.count(), 1)
  assert.equal(Object.hasOwn(outbox.first(), 'payload'), false)
  await sync.flush()

  assert.equal(outbox.count(), 0)
  assert.equal(state.saves, 2)
  const uploadRequests = requests.filter(request => request.path.includes('/task-1/'))
  assert.equal(uploadRequests.length, 3)
  assert.equal(uploadRequests[1].body.baseSequence, 0)
  assert.equal(uploadRequests[1].body.fencingToken, 7)
  assert.equal(uploadRequests[1].body.turns[0].payload.assistantMessage, 'Done')
  assert.equal(uploadRequests[2].path, '/wework-transcripts/task-1/lease/release')
})

test('restores archived turns before the resumed hot tail', async () => {
  const state = {
    value: { version: 2, transcripts: {}, preferencesHash: null },
    async save() {},
  }
  const desktop = {
    preferences: {
      async get() {
        return {}
      },
      async update() {},
    },
    weworkSync: {
      async request(request) {
        if (request.path === '/wework-transcripts?includeArchived=true') {
          return {
            status: 200,
            body: {
              items: [
                {
                  transcriptId: 'shared-transcript',
                  currentSequence: 3,
                  archivedThroughSequence: 2,
                  archives: [{ id: 4, fromSequence: 1, toSequence: 2 }],
                },
              ],
            },
          }
        }
        if (request.path.includes('/archives/4/turns')) {
          return {
            status: 200,
            body: {
              turns: [
                { turnId: 'turn-1', sequence: 1, payload: {} },
                { turnId: 'turn-2', sequence: 2, payload: {} },
              ],
              hasMore: false,
            },
          }
        }
        if (request.path.includes('/turns?after=2')) {
          return {
            status: 200,
            body: {
              turns: [{ turnId: 'turn-3', sequence: 3, payload: {} }],
              hasMore: false,
            },
          }
        }
        if (request.path.includes('/load?')) {
          return { status: 200, body: { global: null } }
        }
        return { status: 200, body: {} }
      },
    },
  }
  const sync = new WeworkSync({
    apiBaseUrl: 'https://cloud.example.com/api',
    clientId: 'client-2',
    desktop,
    outbox: new MemorySyncOutbox(),
    source: createTurnSource(),
    state,
  })

  await sync.flush()

  const restored = state.value.transcripts['shared-transcript']
  assert.deepEqual(
    restored.turns.map(turn => turn.sequence),
    [1, 2, 3]
  )
  assert.deepEqual(restored.downloadedArchiveIds, [4])
  assert.equal(restored.downloadedThrough, 3)
})

test('keeps offline turns queued and discovers a cloud connection later', async () => {
  let cloudConnection = null
  const requests = []
  const outbox = new MemorySyncOutbox()
  const source = createTurnSource()
  const state = {
    value: { version: 2, transcripts: {}, preferencesHash: null },
    async save() {},
  }
  const desktop = {
    preferences: {
      async get() {
        return { cloudConnection }
      },
      async update() {},
    },
    weworkSync: {
      async request(request) {
        requests.push(request)
        if (request.path.endsWith('/lease')) {
          return { status: 200, body: { fencingToken: 9, currentSequence: 0 } }
        }
        if (request.path === '/wework-transcripts?includeArchived=true') {
          return { status: 200, body: { items: [] } }
        }
        if (request.path.includes('/load?')) {
          return { status: 200, body: { global: null } }
        }
        return { status: 200, body: { appended: 1 } }
      },
    },
  }
  const sync = new WeworkSync({
    apiBaseUrl: null,
    clientId: 'client-offline',
    desktop,
    outbox,
    source,
    state,
  })
  const turn = {
    transcriptId: 'offline-transcript',
    taskId: 'local-task',
    title: 'Offline task',
    sequence: 1,
    turnId: 'offline-turn',
    sessionId: 'offline-session',
    payload: {},
  }
  source.add(turn)

  await sync.enqueue(turn)
  assert.equal(outbox.count(), 1)
  assert.equal(requests.length, 0)

  cloudConnection = { backendUrl: 'https://cloud.example.com' }
  await sync.flush()

  assert.equal(outbox.count(), 0)
  assert.equal(requests[0].apiBaseUrl, 'https://cloud.example.com/api')
})

test('forks an offline device turn when another device commits from the same causal head', async () => {
  const requests = []
  const pending = completedTurn({
    transcriptId: 'shared-transcript',
    taskId: 'device-b-task',
    title: 'Shared task',
    sequence: 2,
    baseSequence: 1,
    cloudSequence: 2,
    turnId: 'device-b-turn-2',
    sessionId: 'device-b-session',
    payload: { assistantMessage: 'B recovered' },
  })
  const outbox = new MemorySyncOutbox([pending])
  const state = {
    value: {
      version: 2,
      transcripts: {},
      preferencesHash: null,
    },
    async save() {},
  }
  const desktop = {
    weworkSync: {
      async request(request) {
        requests.push(request)
        if (request.path.endsWith('/lease')) {
          return {
            status: 200,
            body: {
              fencingToken: 12,
              currentSequence: request.path.includes('/shared-transcript/') ? 2 : 0,
            },
          }
        }
        if (request.method === 'POST' && request.path.endsWith('/turns')) {
          return { status: 200, body: { currentSequence: 1, appended: 1 } }
        }
        if (request.method === 'GET' && request.path.includes('/turns?after=1')) {
          return {
            status: 200,
            body: {
              turns: [{ turnId: 'device-a-turn-2', sequence: 2, payload: {} }],
              currentSequence: 2,
              archivedThroughSequence: 0,
              hasMore: false,
            },
          }
        }
        return { status: 200, body: {} }
      },
    },
  }
  const sync = new WeworkSync({
    apiBaseUrl: 'https://cloud.example.com/api',
    clientId: 'device-b',
    desktop,
    outbox,
    source: createTurnSource([pending]),
    state,
  })

  await sync.flushPending()

  const appends = requests.filter(
    request => request.method === 'POST' && request.path.endsWith('/turns')
  )
  assert.equal(appends.length, 1)
  assert.equal(appends[0].body.baseSequence, 0)
  assert.equal(appends[0].body.turns[0].sequence, 1)
  assert.equal(appends[0].body.turns[0].turnId, 'device-b-turn-2')
  const branchLease = requests.find(
    request => request.path.includes('/fork-') && request.path.endsWith('/lease')
  )
  assert.equal(branchLease.body.parentTranscriptId, 'shared-transcript')
  assert.equal(branchLease.body.forkedAtSequence, 1)
  assert.equal(outbox.count(), 0)
})
