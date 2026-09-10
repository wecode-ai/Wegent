import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
} from '../modules/shared.mjs'

const FIRST_PROMPT = 'WEWORK_DESKTOP_E2E_NATIVE_TRANSCRIPT_SNAPSHOT'
const FIRST_COMPLETION = 'WEWORK_DESKTOP_E2E_NATIVE_TRANSCRIPT_SNAPSHOT_COMPLETE'
const SECOND_PROMPT = 'WEWORK_DESKTOP_E2E_NATIVE_TRANSCRIPT_DELTA'
const SECOND_COMPLETION = 'WEWORK_DESKTOP_E2E_NATIVE_TRANSCRIPT_DELTA_COMPLETE'
const RESTORED_PROMPT = 'WEWORK_DESKTOP_E2E_NATIVE_TRANSCRIPT_RESTORED_DEVICE'
const RESTORED_COMPLETION = 'WEWORK_DESKTOP_E2E_NATIVE_TRANSCRIPT_RESTORED_DEVICE_COMPLETE'
const THIRD_PROMPT = 'WEWORK_DESKTOP_E2E_NATIVE_TRANSCRIPT_DISABLED_QUEUE'
const THIRD_COMPLETION = 'WEWORK_DESKTOP_E2E_NATIVE_TRANSCRIPT_DISABLED_QUEUE_COMPLETE'
const REMOTE_PROMPT = 'WEWORK_DESKTOP_E2E_NATIVE_TRANSCRIPT_REMOTE_CONFLICT'
const REMOTE_COMPLETION = 'WEWORK_DESKTOP_E2E_NATIVE_TRANSCRIPT_REMOTE_CONFLICT_COMPLETE'
const NEW_CHAT_PROMPT = 'WEWORK_DESKTOP_E2E_NATIVE_TRANSCRIPT_NEW_CHAT'
const NEW_CHAT_COMPLETION = 'WEWORK_DESKTOP_E2E_NATIVE_TRANSCRIPT_NEW_CHAT_COMPLETE'
const OTHER_PROJECT_PROMPT = 'WEWORK_DESKTOP_E2E_NATIVE_TRANSCRIPT_OTHER_PROJECT'
const OTHER_PROJECT_COMPLETION = 'WEWORK_DESKTOP_E2E_NATIVE_TRANSCRIPT_OTHER_PROJECT_COMPLETE'
const RESTORED_WORKSPACE_MARKER = 'restored-from-encrypted-cloud-segments'
const SYNC_POLL_INTERVAL_MS = 5_000
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')

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

async function rawBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function multipartUpload(request) {
  const contentType = String(request.headers['content-type'] || '')
  const boundary = contentType.match(/boundary=([^;]+)/u)?.[1]
  assert.ok(boundary, 'Transcript upload must include a multipart boundary')
  const body = await rawBody(request)
  const metadataHeader = body.indexOf(Buffer.from('name="metadata"'))
  assert.notEqual(metadataHeader, -1, 'Transcript multipart upload must include metadata')
  const metadataStart = body.indexOf(Buffer.from('\r\n\r\n'), metadataHeader) + 4
  const metadataEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), metadataStart)
  assert.ok(
    metadataStart >= 4 && metadataEnd > metadataStart,
    'Transcript metadata part is malformed'
  )
  const fileHeader = body.indexOf(Buffer.from('name="file"'))
  assert.notEqual(fileHeader, -1, 'Transcript multipart upload must include the file field')
  const contentStart = body.indexOf(Buffer.from('\r\n\r\n'), fileHeader) + 4
  const contentEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart)
  assert.ok(contentStart >= 4 && contentEnd > contentStart, 'Transcript file part is malformed')
  return {
    metadata: JSON.parse(body.subarray(metadataStart, metadataEnd).toString('utf8')),
    file: body.subarray(contentStart, contentEnd),
  }
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

function sqliteOutboxCount(path) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return Number(database.prepare('SELECT COUNT(*) AS count FROM pending_turns').get().count)
  } finally {
    database.close()
  }
}

function summary(transcriptId, transcript) {
  const latestSnapshot = transcript.archives
    .filter(archive => archive.format.includes('snapshot'))
    .at(-1)
  return {
    transcriptId,
    parentTranscriptId: transcript.parentTranscriptId,
    forkedAtSequence: transcript.forkedAtSequence,
    title: transcript.title,
    state: 'active',
    currentSequence: transcript.currentSequence,
    archivedThroughSequence: latestSnapshot?.toSequence ?? 0,
    writerClientId: null,
    writerLeaseExpiresAt: null,
    archives: transcript.archives,
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
    archivedAt: null,
  }
}

export function createDesktopScenario({
  captureScreenshot,
  electronUserDataDirectory,
  resultDir,
  uiTimeoutMs,
  workspacePath,
}) {
  const port = process.env.WEWORK_E2E_MODEL_SERVER_PORT
  assert.ok(port, 'Transcript sync E2E requires a reserved model server port')
  const origin = `http://127.0.0.1:${port}`
  const apiBaseUrl = `${origin}/api`
  seedCloudCredential(electronUserDataDirectory, apiBaseUrl)

  const transcripts = new Map()
  const objects = new Map()
  const requestLog = []
  const modelRequests = []
  let activeTranscriptId = null
  let preferenceValue = null
  let fencingToken = 0
  const leases = new Map()
  let firstCommitResponseDropped = false
  let restartDesktopApp = null
  let modelSequence = 0

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
      requestLog.push(`${request.method} ${url.pathname}${url.search}`)

      if (request.method === 'POST' && url.pathname === '/api/auth/wework/refresh') {
        const body = await requestBody(request)
        assert.equal(body.refresh_token, 'desktop-e2e-transcript-sync-refresh')
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
        preferenceValue = (await requestBody(request)).value
        json(response, 200, { global: preferenceValue })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/wework-transcripts') {
        json(response, 200, {
          items: [...transcripts].map(([id, transcript]) => summary(id, transcript)),
        })
        return true
      }

      const transcriptMatch = url.pathname.match(/^\/api\/wework-transcripts\/([^/]+)$/u)
      if (request.method === 'GET' && transcriptMatch) {
        const transcriptId = decodeURIComponent(transcriptMatch[1])
        json(response, 200, summary(transcriptId, transcripts.get(transcriptId)))
        return true
      }
      const encryptionKeyMatch = url.pathname.match(
        /^\/api\/wework-transcripts\/([^/]+)\/encryption-key$/u
      )
      if (request.method === 'GET' && encryptionKeyMatch) {
        json(response, 200, {
          version: 1,
          algorithm: 'aes-256-gcm',
          key: TEST_ENCRYPTION_KEY,
        })
        return true
      }
      const leaseMatch = url.pathname.match(/^\/api\/wework-transcripts\/([^/]+)\/lease$/u)
      if (request.method === 'POST' && leaseMatch) {
        const transcriptId = decodeURIComponent(leaseMatch[1])
        const body = await requestBody(request)
        const currentLease = leases.get(transcriptId)
        if (currentLease && currentLease.clientId !== body.clientId) {
          json(response, 409, {
            detail: {
              code: 'lease_held',
              message: 'Wework transcript is being edited on another device',
            },
          })
          return true
        }
        activeTranscriptId ??= transcriptId
        const transcript = transcripts.get(transcriptId) ?? {
          title: body.title ?? transcriptId,
          parentTranscriptId: body.parentTranscriptId ?? null,
          forkedAtSequence: body.forkedAtSequence ?? null,
          currentSequence: 0,
          archives: [],
          turns: [],
        }
        transcripts.set(transcriptId, transcript)
        fencingToken += 1
        leases.set(transcriptId, { clientId: body.clientId, fencingToken })
        json(response, 200, {
          transcriptId,
          clientId: body.clientId,
          fencingToken,
          expiresAt: '2026-09-08T01:00:00.000Z',
          currentSequence: transcript.currentSequence,
        })
        return true
      }
      const commitMatch = url.pathname.match(/^\/api\/wework-transcripts\/([^/]+)\/segments$/u)
      if (request.method === 'POST' && commitMatch) {
        const transcriptId = decodeURIComponent(commitMatch[1])
        assert.equal(
          request.headers.authorization,
          'bearer wework-desktop-e2e-cloud-token',
          'Transcript upload must be authenticated through Backend'
        )
        const upload = await multipartUpload(request)
        const body = upload.metadata
        const transcript = transcripts.get(transcriptId)
        assert.equal(body.baseSequence, transcript.currentSequence)
        assert.deepEqual(
          { clientId: body.clientId, fencingToken: body.fencingToken },
          leases.get(transcriptId)
        )
        const objectId = `${transcriptId}-${body.sequence}-${body.sha256}`
        assert.equal(upload.file.byteLength, body.sizeBytes)
        assert.equal(createHash('sha256').update(upload.file).digest('hex'), body.sha256)
        objects.set(objectId, upload.file)
        const existing = transcript.archives.find(archive => archive.toSequence === body.sequence)
        const existingTurn = transcript.turns.find(turn => turn.sequence === body.sequence)
        assert.equal(typeof body.turnId, 'string')
        assert.equal(typeof body.summary, 'object')
        if (!existing) {
          transcript.archives.push({
            id: transcript.archives.length + 1,
            fromSequence: body.format.includes('snapshot') ? 0 : body.sequence,
            toSequence: body.sequence,
            sha256: body.sha256,
            sizeBytes: body.sizeBytes,
            format: body.format,
            createdAt: '2026-09-08T00:00:00.000Z',
            objectId,
          })
          transcript.turns.push({
            turnId: body.turnId,
            sequence: body.sequence,
            payload: structuredClone(body.summary),
            createdAt: '2026-09-08T00:00:00.000Z',
          })
          transcript.currentSequence = body.sequence
        } else {
          assert.equal(existingTurn.turnId, body.turnId)
          assert.deepEqual(existingTurn.payload, body.summary)
        }
        if (body.sequence === 1 && !firstCommitResponseDropped) {
          firstCommitResponseDropped = true
          response.destroy()
          return true
        }
        json(response, 200, {
          currentSequence: transcript.currentSequence,
          appended: existing ? 0 : 1,
        })
        return true
      }
      const turnsMatch = url.pathname.match(/^\/api\/wework-transcripts\/([^/]+)\/turns$/u)
      if (request.method === 'GET' && turnsMatch) {
        const transcript = transcripts.get(decodeURIComponent(turnsMatch[1]))
        const after = Number(url.searchParams.get('after') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 100)
        const selected = transcript.turns.filter(turn => turn.sequence > after)
        json(response, 200, {
          turns: selected.slice(0, limit),
          currentSequence: transcript.currentSequence,
          archivedThroughSequence:
            transcript.archives.filter(archive => archive.fromSequence === 0).at(-1)?.toSequence ??
            0,
          hasMore: selected.length > limit,
        })
        return true
      }
      const releaseMatch = url.pathname.match(
        /^\/api\/wework-transcripts\/([^/]+)\/lease\/release$/u
      )
      if (request.method === 'POST' && releaseMatch) {
        const transcriptId = decodeURIComponent(releaseMatch[1])
        const body = await requestBody(request)
        assert.deepEqual(
          { clientId: body.clientId, fencingToken: body.fencingToken },
          leases.get(transcriptId)
        )
        leases.delete(transcriptId)
        json(response, 200, { released: true })
        return true
      }
      const downloadMatch = url.pathname.match(
        /^\/api\/wework-transcripts\/([^/]+)\/archives\/(\d+)\/download$/u
      )
      if (request.method === 'GET' && downloadMatch) {
        const transcript = transcripts.get(decodeURIComponent(downloadMatch[1]))
        const archive = transcript.archives.find(item => item.id === Number(downloadMatch[2]))
        const object = objects.get(archive.objectId)
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(object.byteLength),
        })
        response.end(object)
        return true
      }
      if (request.method === 'POST' && ['/responses', '/v1/responses'].includes(url.pathname)) {
        const body = await requestBody(request)
        modelRequests.push(structuredClone(body))
        const serialized = JSON.stringify(body)
        const completion = serialized.includes(OTHER_PROJECT_PROMPT)
          ? OTHER_PROJECT_COMPLETION
          : serialized.includes(NEW_CHAT_PROMPT)
            ? NEW_CHAT_COMPLETION
            : serialized.includes(REMOTE_PROMPT)
              ? REMOTE_COMPLETION
              : serialized.includes(THIRD_PROMPT)
                ? THIRD_COMPLETION
                : serialized.includes(RESTORED_PROMPT)
                  ? RESTORED_COMPLETION
                  : serialized.includes(SECOND_PROMPT)
                    ? SECOND_COMPLETION
                    : serialized.includes(FIRST_PROMPT)
                      ? FIRST_COMPLETION
                      : null
        if (!completion) return false
        modelSequence += 1
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(sse(completedResponse(`transcript-sync-${modelSequence}`, completion)))
        return true
      }
      return false
    },

    async verify(control) {
      const deviceAStatePath = join(
        electronUserDataDirectory,
        'dsh-core',
        'wework-transcript-sync.json'
      )
      const deviceAOutboxPath = join(
        electronUserDataDirectory,
        'dsh-core',
        'wework-transcript-sync-outbox.sqlite3'
      )
      await createSingleRootLocalProject(control, workspacePath, 'transcript-sync')
      await writeFile(join(workspacePath, 'transcript-sync-restore-marker.txt'), 'snapshot\n')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: FIRST_PROMPT })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: FIRST_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await waitFor(
        () =>
          activeTranscriptId &&
          activeTranscript()?.currentSequence === 1 &&
          firstCommitResponseDropped &&
          sqliteOutboxCount(deviceAOutboxPath) === 1,
        uiTimeoutMs,
        'Native snapshot was not retained after losing the commit response'
      )
      assert.equal(typeof restartDesktopApp, 'function')
      await restartDesktopApp()
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await waitFor(
        () => leases.size === 0 && sqliteOutboxCount(deviceAOutboxPath) === 0,
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'Restart did not reconcile the already committed native snapshot'
      )
      assert.equal(activeTranscript().archives[0].format, 'codex-snapshot.v1.tgz.aes256gcm')
      assert.equal(activeTranscript().turns[0].payload.assistantMessage, FIRST_COMPLETION)
      await captureScreenshot(control, 'transcript-sync-01-device-a-snapshot-uploaded.png', 'body')

      await writeFile(
        join(workspacePath, 'transcript-sync-restore-marker.txt'),
        `${RESTORED_WORKSPACE_MARKER}\n`
      )
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: SECOND_PROMPT })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: SECOND_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await waitFor(
        () =>
          activeTranscript().currentSequence === 2 &&
          sqliteOutboxCount(deviceAOutboxPath) === 0 &&
          leases.size === 0,
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'Second turn did not upload a native rollout delta'
      )
      assert.equal(activeTranscript().archives[1].format, 'codex-delta.v1.tgz.aes256gcm')
      assert.equal(activeTranscript().turns[1].payload.assistantMessage, SECOND_COMPLETION)
      await captureScreenshot(control, 'transcript-sync-02-device-a-delta-uploaded.png', 'body')
      const snapshotObject = objects.get(activeTranscript().archives[0].objectId)
      const deltaObject = objects.get(activeTranscript().archives[1].objectId)
      assert.ok(snapshotObject.byteLength > 0)
      assert.ok(deltaObject.byteLength > 0)
      assert.equal(snapshotObject.subarray(0, 4).toString('ascii'), 'WTRN')
      assert.equal(deltaObject.subarray(0, 4).toString('ascii'), 'WTRN')
      assert.notDeepEqual([...snapshotObject.subarray(0, 2)], [0x1f, 0x8b])

      const secondRequest = modelRequests.find(request =>
        JSON.stringify(request).includes(SECOND_PROMPT)
      )
      assert.ok(JSON.stringify(secondRequest).includes(FIRST_COMPLETION))

      const transcriptId = activeTranscriptId
      const deviceBRoot = join(resultDir, 'simulated-device-b')
      const deviceBHome = join(deviceBRoot, 'home')
      const deviceBExecutorHome = join(deviceBRoot, 'executor-home')
      const deviceBCodexSqliteHome = join(deviceBRoot, 'codex-sqlite')
      const deviceBUserDataDirectory = join(deviceBRoot, 'electron-user-data')
      const deviceBStatePath = join(
        deviceBUserDataDirectory,
        'dsh-core',
        'wework-transcript-sync.json'
      )
      const deviceBOutboxPath = join(
        deviceBUserDataDirectory,
        'dsh-core',
        'wework-transcript-sync-outbox.sqlite3'
      )
      await restartDesktopApp({
        afterStop: async () => {
          await Promise.all([
            mkdir(deviceBHome, { recursive: true }),
            mkdir(deviceBCodexSqliteHome, { recursive: true }),
          ])
          await writeFile(join(deviceBHome, '.zshrc'), '# Wework simulated device B shell\n')
          seedCloudCredential(deviceBUserDataDirectory, apiBaseUrl)
        },
        appEnvironmentOverrides: {
          CODEX_SQLITE_HOME: deviceBCodexSqliteHome,
          HOME: deviceBHome,
          WEGENT_STANDALONE_WORKSPACE_ROOT: join(deviceBHome, 'Documents', 'Codex'),
          WEGENT_CODEX_HOME: join(deviceBExecutorHome, 'codex'),
          WEGENT_EXECUTOR_HOME: deviceBExecutorHome,
          WEGENT_EXECUTOR_LOG_FILE: 'executor-device-b.log',
          WEWORK_APP_CONFIG_DIR: join(deviceBHome, 'app-config'),
          WEWORK_USER_DATA_DIR: deviceBUserDataDirectory,
        },
        expectNewDeviceIdentity: true,
      })
      await control.command('waitFor', '[data-testid="telemetry-consent-overlay"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clickWhenEnabled', '[data-testid="telemetry-consent-decline"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      const restoredTask = await waitFor(
        async () => {
          try {
            const index = JSON.parse(
              await readFile(join(deviceBExecutorHome, 'runtime-work', 'index.json'), 'utf8')
            )
            const task = index.tasks?.[transcriptId]
            return task?.runtime_handle?.cloudTranscript?.importedThrough === 2 ? task : null
          } catch (error) {
            if (error?.code === 'ENOENT') return null
            throw error
          }
        },
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'Fresh native state did not restore the encrypted snapshot and delta'
      )
      assert.equal(
        await readFile(
          join(restoredTask.workspace_path, 'transcript-sync-restore-marker.txt'),
          'utf8'
        ),
        `${RESTORED_WORKSPACE_MARKER}\n`
      )
      const restoredTaskRowSelector = `[data-testid="runtime-local-task-row-${transcriptId}"]`
      await control.command('waitFor', restoredTaskRowSelector, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clickWhenEnabled', restoredTaskRowSelector, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: SECOND_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'transcript-sync-03-device-b-restored-history.png', 'body')
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: RESTORED_PROMPT })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: RESTORED_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await waitFor(
        () =>
          activeTranscript().currentSequence === 3 && sqliteOutboxCount(deviceBOutboxPath) === 0,
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'Restored device did not continue and upload the next native delta'
      )
      assert.equal(activeTranscript().turns[2].payload.assistantMessage, RESTORED_COMPLETION)
      assert.equal(activeTranscript().archives[2].format, 'codex-snapshot.v1.tgz.aes256gcm')
      const restoredRequest = modelRequests.find(request =>
        JSON.stringify(request).includes(RESTORED_PROMPT)
      )
      assert.ok(JSON.stringify(restoredRequest).includes(FIRST_COMPLETION))
      assert.ok(JSON.stringify(restoredRequest).includes(SECOND_COMPLETION))
      await captureScreenshot(
        control,
        'transcript-sync-04-device-b-continued-sequence-3.png',
        'body'
      )

      await control.command('click', '[data-testid="settings-button"]')
      await control.command('click', '[data-testid="settings-menu-button"]')
      await control.command('click', '[data-testid="settings-nav-connections"]')
      await control.command('waitFor', '[data-testid="transcript-sync-enabled-status"]', {
        text: '同步正常',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="transcript-sync-enabled-checkbox"]')
      await control.command('waitFor', '[data-testid="transcript-sync-enabled-status"]', {
        text: '同步已关闭',
        timeoutMs: uiTimeoutMs,
      })
      const syncRequestsAfterDisable = requestLog.filter(value =>
        value.includes('/api/wework-transcripts')
      ).length
      await control.command('click', '[data-testid="settings-back-button"]')
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: THIRD_PROMPT })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: THIRD_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await new Promise(resolve => setTimeout(resolve, SYNC_POLL_INTERVAL_MS + 500))
      assert.equal(
        requestLog.filter(value => value.includes('/api/wework-transcripts')).length,
        syncRequestsAfterDisable
      )
      assert.equal(sqliteOutboxCount(deviceBOutboxPath), 1)
      await control.command('click', '[data-testid="settings-button"]')
      await control.command('click', '[data-testid="settings-menu-button"]')
      await control.command('click', '[data-testid="settings-nav-connections"]')
      await control.command('waitFor', '[data-testid="transcript-sync-enabled-status"]', {
        text: '同步已关闭',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(
        control,
        'transcript-sync-05-device-b-sync-disabled-queued.png',
        'body'
      )

      const deviceCRoot = join(resultDir, 'simulated-device-c')
      const deviceCHome = join(deviceCRoot, 'home')
      const deviceCExecutorHome = join(deviceCRoot, 'executor-home')
      const deviceCCodexSqliteHome = join(deviceCRoot, 'codex-sqlite')
      const deviceCUserDataDirectory = join(deviceCRoot, 'electron-user-data')
      await restartDesktopApp({
        afterStop: async () => {
          await Promise.all([
            mkdir(deviceCHome, { recursive: true }),
            mkdir(deviceCCodexSqliteHome, { recursive: true }),
          ])
          await writeFile(join(deviceCHome, '.zshrc'), '# Wework simulated device C shell\n')
          seedCloudCredential(deviceCUserDataDirectory, apiBaseUrl)
        },
        appEnvironmentOverrides: {
          CODEX_SQLITE_HOME: deviceCCodexSqliteHome,
          HOME: deviceCHome,
          WEGENT_STANDALONE_WORKSPACE_ROOT: join(deviceCHome, 'Documents', 'Codex'),
          WEGENT_CODEX_HOME: join(deviceCExecutorHome, 'codex'),
          WEGENT_EXECUTOR_HOME: deviceCExecutorHome,
          WEGENT_EXECUTOR_LOG_FILE: 'executor-device-c.log',
          WEWORK_APP_CONFIG_DIR: join(deviceCHome, 'app-config'),
          WEWORK_USER_DATA_DIR: deviceCUserDataDirectory,
        },
        expectNewDeviceIdentity: true,
      })
      await control.command('waitFor', '[data-testid="telemetry-consent-overlay"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clickWhenEnabled', '[data-testid="telemetry-consent-decline"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await waitFor(
        async () => {
          try {
            const index = JSON.parse(
              await readFile(join(deviceCExecutorHome, 'runtime-work', 'index.json'), 'utf8')
            )
            return (
              index.tasks?.[transcriptId]?.runtime_handle?.cloudTranscript?.importedThrough === 3
            )
          } catch (error) {
            if (error?.code === 'ENOENT') return false
            throw error
          }
        },
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'The second active device did not restore the shared transcript before diverging'
      )
      const deviceCRestoredTaskRowSelector = `[data-testid="runtime-local-task-row-${transcriptId}"]`
      await control.command('waitFor', deviceCRestoredTaskRowSelector, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', deviceCRestoredTaskRowSelector)
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: REMOTE_PROMPT })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: REMOTE_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await waitFor(
        () =>
          activeTranscript().currentSequence === 4 &&
          activeTranscript().turns[3].payload.assistantMessage === REMOTE_COMPLETION &&
          leases.size === 0,
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'The remote device did not advance the shared transcript'
      )

      await restartDesktopApp({
        appEnvironmentOverrides: {
          CODEX_SQLITE_HOME: deviceBCodexSqliteHome,
          HOME: deviceBHome,
          WEGENT_STANDALONE_WORKSPACE_ROOT: join(deviceBHome, 'Documents', 'Codex'),
          WEGENT_CODEX_HOME: join(deviceBExecutorHome, 'codex'),
          WEGENT_EXECUTOR_HOME: deviceBExecutorHome,
          WEGENT_EXECUTOR_LOG_FILE: 'executor-device-b.log',
          WEWORK_APP_CONFIG_DIR: join(deviceBHome, 'app-config'),
          WEWORK_USER_DATA_DIR: deviceBUserDataDirectory,
        },
        expectNewDeviceIdentity: true,
      })
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('click', '[data-testid="settings-button"]')
      await control.command('click', '[data-testid="settings-menu-button"]')
      await control.command('click', '[data-testid="settings-nav-connections"]')
      await control.command('waitFor', '[data-testid="transcript-sync-enabled-status"]', {
        text: '同步已关闭',
        timeoutMs: uiTimeoutMs,
      })
      leases.set(transcriptId, {
        clientId: 'simulated-external-writer',
        fencingToken: ++fencingToken,
      })
      await control.command('click', '[data-testid="transcript-sync-enabled-checkbox"]')
      await control.command('waitFor', '[data-testid="transcript-sync-enabled-status"]', {
        text: '同步失败',
        timeoutMs: uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
      })
      await control.command('waitFor', '[data-testid="transcript-sync-runtime-error"]', {
        text: 'another device',
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(sqliteOutboxCount(deviceBOutboxPath), 1)
      leases.delete(transcriptId)
      await control.command('click', '[data-testid="transcript-sync-retry-button"]')
      const forkEntry = await waitFor(
        () =>
          [...transcripts].find(
            ([id, transcript]) =>
              id !== transcriptId &&
              transcript.parentTranscriptId === transcriptId &&
              transcript.forkedAtSequence === 3 &&
              transcript.currentSequence === 1
          ),
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'The conflicting local continuation was not preserved as a branch'
      )
      const [forkTranscriptId, forkTranscript] = forkEntry
      assert.equal(forkTranscript.turns[0].payload.assistantMessage, THIRD_COMPLETION)
      assert.equal(activeTranscript().turns[3].payload.assistantMessage, REMOTE_COMPLETION)
      await waitFor(
        async () => {
          const index = JSON.parse(
            await readFile(join(deviceBExecutorHome, 'runtime-work', 'index.json'), 'utf8')
          )
          return index.tasks?.[forkTranscriptId] && index.tasks?.[transcriptId]
        },
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'The fork and original transcript did not become two independent local conversations'
      )
      await waitFor(
        () => sqliteOutboxCount(deviceBOutboxPath) === 0,
        uiTimeoutMs,
        'The acknowledged branch turn was not removed from the outbox'
      )
      await control.command('waitFor', '[data-testid="transcript-sync-enabled-status"]', {
        text: '同步正常',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(
        control,
        'transcript-sync-06-conflict-preserved-as-branch.png',
        'body'
      )

      await control.command('click', '[data-testid="settings-back-button"]')
      const newChatProjectPath = join(resultDir, 'transcript-sync-new-chat-project')
      await mkdir(newChatProjectPath, { recursive: true })
      await createSingleRootLocalProject(
        control,
        newChatProjectPath,
        'transcript-sync-new-chat-project',
        uiTimeoutMs
      )
      const beforeNewChatIds = new Set(transcripts.keys())
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: NEW_CHAT_PROMPT })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: NEW_CHAT_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      const newChatEntry = await waitFor(
        () =>
          [...transcripts].find(
            ([id, transcript]) =>
              !beforeNewChatIds.has(id) &&
              transcript.parentTranscriptId === null &&
              transcript.currentSequence === 1
          ),
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'A new conversation did not create an independent cloud transcript'
      )
      const [newChatTranscriptId, newChatTranscript] = newChatEntry
      assert.equal(newChatTranscript.turns[0].payload.assistantMessage, NEW_CHAT_COMPLETION)
      assert.notEqual(newChatTranscriptId, transcriptId)
      assert.notEqual(newChatTranscriptId, forkTranscriptId)

      const otherProjectPath = join(resultDir, 'transcript-sync-other-project')
      const beforeOtherProjectIds = new Set(transcripts.keys())
      await mkdir(otherProjectPath, { recursive: true })
      await createSingleRootLocalProject(
        control,
        otherProjectPath,
        'transcript-sync-other-project',
        uiTimeoutMs
      )
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: OTHER_PROJECT_PROMPT })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: OTHER_PROJECT_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      const otherProjectEntry = await waitFor(
        () =>
          [...transcripts].find(
            ([id, transcript]) =>
              !beforeOtherProjectIds.has(id) &&
              transcript.parentTranscriptId === null &&
              transcript.currentSequence === 1
          ),
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'A conversation in another project did not create an independent cloud transcript'
      )
      const [otherProjectTranscriptId, otherProjectTranscript] = otherProjectEntry
      assert.equal(
        otherProjectTranscript.turns[0].payload.assistantMessage,
        OTHER_PROJECT_COMPLETION
      )
      const finalIndex = JSON.parse(
        await readFile(join(deviceBExecutorHome, 'runtime-work', 'index.json'), 'utf8')
      )
      assert.equal(finalIndex.tasks[otherProjectTranscriptId].workspace_path, otherProjectPath)
      assert.equal(activeTranscript().currentSequence, 4)
      assert.equal(forkTranscript.currentSequence, 1)
      assert.equal(newChatTranscript.currentSequence, 1)

      const persisted = JSON.parse(await readFile(deviceBStatePath, 'utf8'))
      assert.equal(Object.hasOwn(persisted.transcripts[activeTranscriptId], 'turns'), false)
      assert.ok((await readFile(deviceAStatePath, 'utf8')).includes(activeTranscriptId))
      assert.equal(
        requestLog.some(value => value.includes('/transcript-objects/')),
        false,
        'Desktop transcript sync must not contact object storage directly'
      )
      await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, { timeoutMs: uiTimeoutMs })
      await captureScreenshot(
        control,
        'transcript-sync-07-new-chat-and-project-isolation.png',
        'body'
      )
    },

    diagnostics() {
      return {
        activeTranscriptId,
        firstCommitResponseDropped,
        modelRequests,
        objectSizes: Object.fromEntries([...objects].map(([key, value]) => [key, value.length])),
        requestLog,
        transcripts: Object.fromEntries(transcripts),
      }
    },
  }
}
