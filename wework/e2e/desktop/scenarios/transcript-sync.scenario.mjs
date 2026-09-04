import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
} from '../modules/shared.mjs'
import { WeworkSync } from '../../../dsh/transcript-sync/index.js'
import { MemorySyncOutbox } from '../../../dsh/transcript-sync/outbox.js'

const ARCHIVE_TRANSCRIPT_ID = 'desktop-e2e-archived-transcript'
const FIRST_PROMPT = 'WEWORK_DESKTOP_E2E_TRANSCRIPT_SYNC_COMMIT_RESPONSE_LOST'
const FIRST_COMPLETION = 'WEWORK_DESKTOP_E2E_TRANSCRIPT_SYNC_COMMIT_RESPONSE_LOST_COMPLETE'
const SECOND_PROMPT = 'WEWORK_DESKTOP_E2E_TRANSCRIPT_SYNC_LEASE_AND_FENCING_RACE'
const SECOND_COMPLETION = 'WEWORK_DESKTOP_E2E_TRANSCRIPT_SYNC_LEASE_AND_FENCING_RACE_COMPLETE'
const THIRD_PROMPT = 'WEWORK_DESKTOP_E2E_TRANSCRIPT_SYNC_A_CONTINUES_WHILE_B_FAILED'
const THIRD_COMPLETION = 'WEWORK_DESKTOP_E2E_TRANSCRIPT_SYNC_A_CONTINUES_WHILE_B_FAILED_COMPLETE'
const SYNC_POLL_INTERVAL_MS = 5_000

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function completedResponse(id, text) {
  return [
    { type: 'response.created', response: { id } },
    {
      type: 'response.output_item.done',
      item: {
        id: `${id}-message`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ]
}

async function requestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function seedCloudCredential(electronUserDataDirectory, apiBaseUrl) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  })
  const publicJwk = publicKey.export({ format: 'jwk' })
  mkdirSync(electronUserDataDirectory, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(electronUserDataDirectory, 'cloud-credentials.json'),
    `${JSON.stringify(
      {
        version: 2,
        apiBaseUrl,
        publicKey: {
          kty: 'EC',
          crv: 'P-256',
          x: publicJwk.x,
          y: publicJwk.y,
        },
        privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        refreshToken: 'desktop-e2e-transcript-sync-refresh',
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
}

async function waitFor(predicate, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}

function transcriptSummary(transcriptId, currentSequence, archives = [], relation = {}) {
  return {
    transcriptId,
    parentTranscriptId: relation.parentTranscriptId ?? null,
    forkedAtSequence: relation.forkedAtSequence ?? null,
    title: transcriptId,
    state: 'active',
    currentSequence,
    archivedThroughSequence: archives.at(-1)?.toSequence ?? 0,
    writerClientId: null,
    writerLeaseExpiresAt: null,
    archives,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    archivedAt: null,
  }
}

function createSimulatedDevice(apiBaseUrl, clientId) {
  const outbox = new MemorySyncOutbox()
  const payloads = new Map()
  const source = {
    read(turn) {
      const payload = payloads.get(turn.turnId)
      assert.ok(payload, `Simulated ${clientId} session lost ${turn.turnId}`)
      return { ...turn, payload: structuredClone(payload) }
    },
  }
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
        const response = await fetch(`${request.apiBaseUrl}${request.path}`, {
          method: request.method,
          headers: {
            authorization: `Bearer ${clientId}`,
            ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        })
        return {
          status: response.status,
          body: await response.json(),
        }
      },
    },
  }
  const sync = new WeworkSync({
    apiBaseUrl,
    clientId,
    desktop,
    outbox,
    source,
    state,
    pollIntervalMs: 60_000,
  })
  return {
    async enqueue(turn) {
      payloads.set(turn.turnId, structuredClone(turn.payload))
      await sync.enqueue(turn)
    },
    outbox,
    state,
    sync,
  }
}

function sqliteOutboxCount(path) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return Number(database.prepare('SELECT COUNT(*) AS count FROM pending_turns').get().count)
  } finally {
    database.close()
  }
}

export function createDesktopScenario({ electronUserDataDirectory, uiTimeoutMs, workspacePath }) {
  const port = process.env.WEWORK_E2E_MODEL_SERVER_PORT
  assert.ok(port, 'Transcript sync E2E requires a reserved model server port')
  const apiBaseUrl = `http://127.0.0.1:${port}/api`
  seedCloudCredential(electronUserDataDirectory, apiBaseUrl)

  const transcripts = new Map()
  const requestLog = []
  const appendAttempts = []
  let modelSequence = 0
  let preferenceValue = null
  let activeTranscriptId = null
  let firstCommitResponseDropped = false
  let secondLeaseRejected = false
  let secondFencingRejected = false
  let deviceAClientId = null
  let failNextDeviceBAppend = false
  let deviceBAppendFailed = false
  let fencingToken = 0
  let lease = null
  let restartDesktopApp = null
  const deviceB = createSimulatedDevice(apiBaseUrl, 'device-b')

  function activeTranscript() {
    assert.ok(activeTranscriptId, 'The active transcript ID was not observed')
    return transcripts.get(activeTranscriptId)
  }

  return {
    appEnvironment: {
      WEWORK_BACKEND_URL: apiBaseUrl,
    },

    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },

    async handleHttp(request, response, url) {
      if (url.pathname.startsWith('/api/')) {
        requestLog.push(`${request.method} ${url.pathname}${url.search}`)
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/wework/refresh') {
        const body = await requestBody(request)
        assert.equal(
          body.refresh_token,
          'desktop-e2e-transcript-sync-refresh',
          'Transcript sync did not refresh the seeded desktop credential'
        )
        json(response, 200, {
          access_token: 'wework-desktop-e2e-cloud-token',
          token_type: 'bearer',
          expires_in: 3600,
        })
        return true
      }

      if (request.method === 'POST' && url.pathname.includes('/dsh-plugin-storage/units/')) {
        json(response, 200, { global: preferenceValue })
        return true
      }
      if (request.method === 'PUT' && url.pathname.includes('/dsh-plugin-storage/units/')) {
        const body = await requestBody(request)
        preferenceValue = body.value
        json(response, 200, { global: preferenceValue })
        return true
      }

      if (request.method === 'GET' && url.pathname === '/api/wework-transcripts') {
        const items = [
          transcriptSummary(ARCHIVE_TRANSCRIPT_ID, 3, [
            {
              id: 41,
              fromSequence: 1,
              toSequence: 2,
              sha256: 'desktop-e2e-archive',
              sizeBytes: 1,
              format: 'jsonl.zst',
              downloadUrl: null,
              createdAt: '2026-09-04T00:00:00.000Z',
            },
          ]),
          ...[...transcripts.entries()].map(([transcriptId, transcript]) =>
            transcriptSummary(transcriptId, transcript.turns.length, [], transcript)
          ),
        ]
        json(response, 200, { items })
        return true
      }

      if (
        request.method === 'GET' &&
        url.pathname === `/api/wework-transcripts/${ARCHIVE_TRANSCRIPT_ID}/archives/41/turns`
      ) {
        json(response, 200, {
          turns: [
            { turnId: 'archive-turn-1', sequence: 1, payload: { assistantMessage: 'archive-1' } },
            { turnId: 'archive-turn-2', sequence: 2, payload: { assistantMessage: 'archive-2' } },
          ],
          currentSequence: 3,
          archivedThroughSequence: 2,
          hasMore: false,
        })
        return true
      }

      if (
        request.method === 'GET' &&
        url.pathname === `/api/wework-transcripts/${ARCHIVE_TRANSCRIPT_ID}/turns`
      ) {
        json(response, 200, {
          turns: [{ turnId: 'hot-turn-3', sequence: 3, payload: { assistantMessage: 'hot-3' } }],
          currentSequence: 3,
          archivedThroughSequence: 2,
          hasMore: false,
        })
        return true
      }

      const leaseMatch = url.pathname.match(/^\/api\/wework-transcripts\/([^/]+)\/lease$/u)
      if (request.method === 'POST' && leaseMatch) {
        const transcriptId = decodeURIComponent(leaseMatch[1])
        const body = await requestBody(request)
        activeTranscriptId ??= transcriptId
        if (body.clientId !== 'device-b') deviceAClientId ??= body.clientId
        const transcript = transcripts.get(transcriptId) ?? {
          turns: [],
          parentTranscriptId: body.parentTranscriptId ?? null,
          forkedAtSequence: body.forkedAtSequence ?? null,
        }
        transcripts.set(transcriptId, transcript)
        if (
          transcript.parentTranscriptId !== (body.parentTranscriptId ?? null) ||
          transcript.forkedAtSequence !== (body.forkedAtSequence ?? null)
        ) {
          json(response, 409, {
            detail: {
              code: 'fork_identity_conflict',
              message: 'Transcript already exists with a different parent',
            },
          })
          return true
        }
        const nextSequence = transcript.turns.length + 1
        if (
          transcriptId === activeTranscriptId &&
          body.clientId === deviceAClientId &&
          nextSequence === 3 &&
          !secondLeaseRejected
        ) {
          secondLeaseRejected = true
          json(response, 409, {
            detail: {
              code: 'lease_held',
              message: 'Wework transcript is being edited on another device',
            },
          })
          return true
        }
        fencingToken += 1
        lease = { clientId: body.clientId, fencingToken }
        json(response, 200, {
          transcriptId,
          clientId: body.clientId,
          fencingToken,
          expiresAt: '2026-09-04T01:00:00.000Z',
          currentSequence: transcript.turns.length,
        })
        return true
      }

      const turnsMatch = url.pathname.match(/^\/api\/wework-transcripts\/([^/]+)\/turns$/u)
      if (request.method === 'POST' && turnsMatch) {
        const transcriptId = decodeURIComponent(turnsMatch[1])
        const body = await requestBody(request)
        const transcript = transcripts.get(transcriptId)
        assert.ok(transcript, 'Append arrived before transcript lease acquisition')
        appendAttempts.push(structuredClone(body))
        assert.equal(body.turns.length, 1, 'Transcript sync uploaded more than one finalized turn')

        if (
          transcriptId === activeTranscriptId &&
          body.clientId === deviceAClientId &&
          body.turns[0].sequence === 3 &&
          !secondFencingRejected
        ) {
          secondFencingRejected = true
          fencingToken += 1
          lease = { clientId: 'competing-device', fencingToken }
          json(response, 409, {
            detail: {
              code: 'lease_invalid',
              message: 'Wework transcript write lease is missing, expired, or stale',
            },
          })
          lease = null
          return true
        }

        if (body.clientId === 'device-b' && failNextDeviceBAppend) {
          failNextDeviceBAppend = false
          deviceBAppendFailed = true
          lease = null
          json(response, 503, {
            detail: {
              code: 'device_offline',
              message: 'Device B lost its network before append completed',
            },
          })
          return true
        }

        assert.deepEqual(
          { clientId: body.clientId, fencingToken: body.fencingToken },
          lease,
          'Transcript append bypassed the active writer fencing token'
        )
        const incoming = body.turns[0]
        const existing = transcript.turns.find(turn => turn.turnId === incoming.turnId)
        if (existing) {
          assert.deepEqual(incoming, existing, 'Idempotent replay changed the committed turn')
        } else if (body.baseSequence !== transcript.turns.length) {
          json(response, 409, {
            detail: {
              code: 'sequence_conflict',
              message: 'Transcript sequence has changed; pull remote turns before retrying',
            },
          })
          return true
        } else {
          transcript.turns.push(structuredClone(incoming))
        }

        if (incoming.sequence === 1 && !firstCommitResponseDropped) {
          firstCommitResponseDropped = true
          response.destroy()
          return true
        }
        json(response, 200, {
          currentSequence: transcript.turns.length,
          appended: existing ? 0 : 1,
        })
        return true
      }

      const releaseMatch = url.pathname.match(
        /^\/api\/wework-transcripts\/([^/]+)\/lease\/release$/u
      )
      if (request.method === 'POST' && releaseMatch) {
        const body = await requestBody(request)
        assert.deepEqual(
          { clientId: body.clientId, fencingToken: body.fencingToken },
          lease,
          'Transcript sync released a lease owned by another writer'
        )
        lease = null
        const transcriptId = decodeURIComponent(releaseMatch[1])
        const transcript = transcripts.get(transcriptId)
        json(
          response,
          200,
          transcriptSummary(transcriptId, transcript?.turns.length ?? 0, [], transcript)
        )
        return true
      }

      if (request.method === 'GET' && turnsMatch) {
        const transcript = transcripts.get(decodeURIComponent(turnsMatch[1])) ?? { turns: [] }
        const after = Number(url.searchParams.get('after') ?? 0)
        json(response, 200, {
          turns: transcript.turns.filter(turn => turn.sequence > after),
          currentSequence: transcript.turns.length,
          archivedThroughSequence: 0,
          hasMore: false,
        })
        return true
      }

      if (request.method === 'POST' && ['/responses', '/v1/responses'].includes(url.pathname)) {
        const body = JSON.stringify(await requestBody(request))
        const completion = body.includes(THIRD_PROMPT)
          ? THIRD_COMPLETION
          : body.includes(SECOND_PROMPT)
            ? SECOND_COMPLETION
            : body.includes(FIRST_PROMPT)
              ? FIRST_COMPLETION
              : null
        if (!completion) return false
        modelSequence += 1
        const responseId = `wework-transcript-sync-${modelSequence}`
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(sse(completedResponse(responseId, completion)))
        return true
      }

      return false
    },

    async verify(control) {
      const statePath = join(electronUserDataDirectory, 'dsh-core', 'wework-transcript-sync.json')
      const outboxPath = join(
        electronUserDataDirectory,
        'dsh-core',
        'wework-transcript-sync-outbox.sqlite3'
      )
      const restoredState = await waitFor(
        async () => {
          try {
            const state = JSON.parse(await readFile(statePath, 'utf8'))
            return state.transcripts?.[ARCHIVE_TRANSCRIPT_ID]?.downloadedThrough === 3
              ? state
              : null
          } catch (error) {
            if (error?.code === 'ENOENT') return null
            throw error
          }
        },
        uiTimeoutMs,
        'Core DSH did not restore the archived transcript and resumed hot tail'
      )
      assert.deepEqual(
        restoredState.transcripts[ARCHIVE_TRANSCRIPT_ID].turns.map(turn => turn.sequence),
        [1, 2, 3],
        'Archive and hot-tail turns were not restored contiguously'
      )
      const archiveRequestIndex = requestLog.findIndex(value =>
        value.includes('/archives/41/turns')
      )
      const hotRequestIndex = requestLog.findIndex(
        value => value.includes(`/${ARCHIVE_TRANSCRIPT_ID}/turns`) && !value.includes('/archives/')
      )
      assert.ok(
        archiveRequestIndex >= 0 && archiveRequestIndex < hotRequestIndex,
        'Core DSH requested the hot tail before restoring archived turns'
      )

      await createSingleRootLocalProject(control, workspacePath, 'transcript-sync')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: FIRST_PROMPT })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: FIRST_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await waitFor(
        () => {
          if (!activeTranscriptId) return null
          const transcript = transcripts.get(activeTranscriptId)
          return (
            transcript?.turns.length === 1 &&
            firstCommitResponseDropped &&
            sqliteOutboxCount(outboxPath) === 1
          )
        },
        uiTimeoutMs,
        'Device A did not retain the committed turn before restart after losing its response'
      )
      assert.equal(
        typeof restartDesktopApp,
        'function',
        'Transcript sync E2E cannot restart Wework'
      )
      const requestCountBeforeRestart = requestLog.length
      await restartDesktopApp()
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await waitFor(
        () => {
          const restartRequests = requestLog.slice(requestCountBeforeRestart)
          return (
            restartRequests.some(
              value =>
                value ===
                `POST /api/wework-transcripts/${encodeURIComponent(activeTranscriptId)}/lease`
            ) &&
            restartRequests.some(value =>
              value.startsWith(
                `GET /api/wework-transcripts/${encodeURIComponent(activeTranscriptId)}/turns?`
              )
            ) &&
            lease === null &&
            sqliteOutboxCount(outboxPath) === 0
          )
        },
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'Restarted device A did not reconcile the committed turn idempotently'
      )

      const transcriptId = activeTranscriptId
      assert.ok(transcriptId, 'Device A did not establish the shared transcript')
      await deviceB.sync.flush()
      assert.deepEqual(
        deviceB.state.value.transcripts[transcriptId].turns.map(turn => turn.sequence),
        [1],
        'Device B did not pull device A transcript before continuing'
      )
      await deviceB.enqueue({
        transcriptId,
        taskId: 'device-b-local-task',
        title: 'Shared transcript',
        sequence: 1,
        turnId: 'device-b-turn-1',
        sessionId: 'device-b-session',
        payload: { assistantMessage: 'Device B continuation' },
      })
      await deviceB.sync.flush()
      assert.deepEqual(
        activeTranscript().turns.map(turn => [turn.sequence, turn.turnId]),
        [
          [1, activeTranscript().turns[0].turnId],
          [2, 'device-b-turn-1'],
        ],
        'Device B did not append after device A'
      )

      await waitFor(
        async () => {
          const state = JSON.parse(await readFile(statePath, 'utf8'))
          return state.transcripts[transcriptId]?.downloadedThrough === 2
        },
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'Device A did not observe device B before continuing the shared mainline'
      )
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: SECOND_PROMPT })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: SECOND_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await waitFor(
        () => {
          const transcript = activeTranscript()
          return (
            transcript.turns.length === 3 &&
            secondLeaseRejected &&
            secondFencingRejected &&
            lease === null
          )
        },
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS * 2,
        'The pending turn did not survive lease contention and a stale fencing token'
      )

      const transcript = activeTranscript()
      assert.deepEqual(
        transcript.turns.map(turn => turn.sequence),
        [1, 2, 3],
        'A→B→A continuation committed duplicate or non-contiguous turns'
      )
      assert.equal(
        transcript.turns[2].payload.assistantMessage,
        SECOND_COMPLETION,
        'Device A did not continue after pulling the device B turn'
      )
      assert.equal(
        appendAttempts.filter(item => item.turns[0].sequence === 1).length,
        1,
        'The response-loss case duplicated an already committed turn during reconciliation'
      )
      assert.equal(
        appendAttempts.filter(
          item => item.clientId === deviceAClientId && item.turns[0].sequence === 3
        ).length,
        2,
        'The fencing race did not retry exactly once with a fresh lease'
      )

      await deviceB.sync.flush()
      assert.deepEqual(
        deviceB.state.value.transcripts[transcriptId].turns.map(turn => turn.sequence),
        [1, 2, 3],
        'Device B did not observe the A→B→A continuation before going offline'
      )
      failNextDeviceBAppend = true
      await deviceB.enqueue({
        transcriptId,
        taskId: 'device-b-local-task',
        title: 'Shared transcript',
        sequence: 2,
        turnId: 'device-b-turn-2',
        sessionId: 'device-b-session',
        payload: { assistantMessage: 'Device B pending while offline' },
      })
      await assert.rejects(deviceB.sync.flush(), /Device B lost its network/u)
      await deviceB.enqueue({
        transcriptId,
        taskId: 'device-b-local-task',
        title: 'Shared transcript',
        sequence: 3,
        turnId: 'device-b-turn-3',
        sessionId: 'device-b-session',
        payload: { assistantMessage: 'Device B second offline continuation' },
      })
      assert.equal(deviceB.outbox.count(), 2, 'Device B lost its offline outbox chain')

      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: THIRD_PROMPT })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: THIRD_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await waitFor(
        () => activeTranscript().turns.length === 4 && lease === null,
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'Device A did not continue while device B retained a failed outbox turn'
      )

      await deviceB.sync.flush()
      const branches = [...transcripts.entries()].filter(
        ([, value]) => value.parentTranscriptId === transcriptId
      )
      assert.equal(branches.length, 1, 'Concurrent device B work did not create one branch')
      const [branchTranscriptId, branch] = branches[0]
      assert.deepEqual(
        activeTranscript().turns.map(turn => [turn.sequence, turn.turnId]),
        [
          [1, activeTranscript().turns[0].turnId],
          [2, 'device-b-turn-1'],
          [3, activeTranscript().turns[2].turnId],
          [4, activeTranscript().turns[3].turnId],
        ],
        'Recovered device B changed the mainline instead of preserving device A'
      )
      assert.equal(branch.forkedAtSequence, 3, 'Device B branch used the wrong causal fork point')
      assert.deepEqual(
        branch.turns.map(turn => [turn.sequence, turn.turnId]),
        [
          [1, 'device-b-turn-2'],
          [2, 'device-b-turn-3'],
        ],
        'Device B offline chain did not stay together on one automatic branch'
      )
      assert.equal(deviceBAppendFailed, true, 'The device B offline failure was not exercised')
      assert.equal(deviceB.outbox.count(), 0, 'Device B outbox remained stuck after branching')

      await waitFor(
        async () => {
          const state = JSON.parse(await readFile(statePath, 'utf8'))
          return state.transcripts[branchTranscriptId]?.downloadedThrough === 2 ? state : null
        },
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'Device A did not pull device B automatic branch'
      )
      const finalState = JSON.parse(await readFile(statePath, 'utf8'))
      assert.equal(
        sqliteOutboxCount(outboxPath),
        0,
        'Successfully synchronized turns remained in the SQLite outbox'
      )
      assert.deepEqual(
        finalState.transcripts[transcriptId].turns.map(turn => turn.sequence),
        [1, 2, 3, 4],
        'Device A mainline mirror changed after device B branched'
      )
      assert.equal(
        finalState.transcripts[branchTranscriptId].parentTranscriptId,
        transcriptId,
        'Device A mirror lost the automatic branch parent'
      )
      assert.deepEqual(
        finalState.transcripts[branchTranscriptId].turns.map(turn => turn.sequence),
        [1, 2],
        'Device A branch mirror did not converge after device B recovered'
      )
      await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, { timeoutMs: uiTimeoutMs })
    },

    diagnostics() {
      return {
        activeTranscriptId,
        appendAttempts,
        branches: Object.fromEntries(
          [...transcripts].filter(([, value]) => value.parentTranscriptId !== null)
        ),
        deviceAClientId,
        deviceBAppendFailed,
        deviceBPending: deviceB.outbox.list(),
        firstCommitResponseDropped,
        requestLog,
        secondFencingRejected,
        secondLeaseRejected,
        transcripts: Object.fromEntries(transcripts),
      }
    },
  }
}
