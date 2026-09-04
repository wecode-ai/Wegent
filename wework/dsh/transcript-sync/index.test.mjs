import assert from 'node:assert/strict'
import test from 'node:test'
import { WeworkSync, portablePreferences, resolveApiBaseUrl } from './index.js'

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

test('persists a finalized turn before uploading it with a writer lease', async () => {
  const requests = []
  const state = {
    value: { version: 1, pending: [], transcripts: {}, preferencesHash: null },
    saves: 0,
    async save() {
      this.saves += 1
    },
  }
  const desktop = {
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
    state,
  })

  await sync.enqueue({
    transcriptId: 'task-1',
    taskId: 'task-1',
    title: 'Task',
    sequence: 1,
    turnId: 'task-1:1',
    payload: { assistantMessage: 'Done' },
  })

  assert.equal(state.value.pending.length, 0)
  assert.equal(state.saves, 3)
  assert.equal(requests.length, 3)
  assert.equal(requests[1].body.baseSequence, 0)
  assert.equal(requests[1].body.fencingToken, 7)
  assert.equal(requests[1].body.turns[0].payload.assistantMessage, 'Done')
  assert.equal(requests[2].path, '/wework-transcripts/task-1/lease/release')
})

test('restores archived turns before the resumed hot tail', async () => {
  const state = {
    value: { version: 1, pending: [], transcripts: {}, preferencesHash: null },
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
  const state = {
    value: { version: 1, pending: [], transcripts: {}, preferencesHash: null },
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
    state,
  })
  const turn = {
    transcriptId: 'offline-transcript',
    taskId: 'local-task',
    title: 'Offline task',
    sequence: 1,
    turnId: 'offline-turn',
    payload: {},
  }

  await sync.enqueue(turn)
  assert.equal(state.value.pending.length, 1)
  assert.equal(requests.length, 0)

  cloudConnection = { backendUrl: 'https://cloud.example.com' }
  await sync.flush()

  assert.equal(state.value.pending.length, 0)
  assert.equal(requests[0].apiBaseUrl, 'https://cloud.example.com/api')
})

test('rebases an offline device turn after another device commits its reserved sequence', async () => {
  const requests = []
  let appendAttempt = 0
  const state = {
    value: {
      version: 1,
      pending: [
        {
          transcriptId: 'shared-transcript',
          taskId: 'device-b-task',
          title: 'Shared task',
          sequence: 2,
          cloudSequence: 2,
          turnId: 'device-b-turn-2',
          payload: { assistantMessage: 'B recovered' },
        },
      ],
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
          return { status: 200, body: { fencingToken: 12, currentSequence: 2 } }
        }
        if (request.method === 'POST' && request.path.endsWith('/turns')) {
          appendAttempt += 1
          if (appendAttempt === 1) {
            return {
              status: 409,
              body: {
                detail: {
                  code: 'sequence_conflict',
                  message: 'Pull remote turns before retrying',
                },
              },
            }
          }
          return { status: 200, body: { currentSequence: 3, appended: 1 } }
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
    state,
  })

  await sync.flushPending()

  const appends = requests.filter(
    request => request.method === 'POST' && request.path.endsWith('/turns')
  )
  assert.deepEqual(
    appends.map(request => request.body.turns[0].sequence),
    [2, 3]
  )
  assert.deepEqual(
    appends.map(request => request.body.turns[0].turnId),
    ['device-b-turn-2', 'device-b-turn-2']
  )
  assert.equal(state.value.pending.length, 0)
})
