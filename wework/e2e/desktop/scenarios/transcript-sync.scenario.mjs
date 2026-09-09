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
  const prepared = new Map()
  const requestLog = []
  const modelRequests = []
  let activeTranscriptId = null
  let preferenceValue = null
  let fencingToken = 0
  let lease = null
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
        activeTranscriptId ??= transcriptId
        const transcript = transcripts.get(transcriptId) ?? {
          title: body.title ?? transcriptId,
          parentTranscriptId: body.parentTranscriptId ?? null,
          forkedAtSequence: body.forkedAtSequence ?? null,
          currentSequence: 0,
          archives: [],
        }
        transcripts.set(transcriptId, transcript)
        fencingToken += 1
        lease = { clientId: body.clientId, fencingToken }
        json(response, 200, {
          transcriptId,
          clientId: body.clientId,
          fencingToken,
          expiresAt: '2026-09-08T01:00:00.000Z',
          currentSequence: transcript.currentSequence,
        })
        return true
      }
      const prepareMatch = url.pathname.match(
        /^\/api\/wework-transcripts\/([^/]+)\/segments\/prepare$/u
      )
      if (request.method === 'POST' && prepareMatch) {
        const transcriptId = decodeURIComponent(prepareMatch[1])
        const body = await requestBody(request)
        const transcript = transcripts.get(transcriptId)
        assert.equal(body.baseSequence, transcript.currentSequence)
        assert.deepEqual({ clientId: body.clientId, fencingToken: body.fencingToken }, lease)
        const objectId = `${transcriptId}-${body.sequence}-${body.sha256}`
        prepared.set(objectId, structuredClone(body))
        json(response, 200, {
          uploadUrl: `${origin}/transcript-objects/${encodeURIComponent(objectId)}`,
          expiresAt: '2026-09-08T01:00:00.000Z',
        })
        return true
      }
      const objectMatch = url.pathname.match(/^\/transcript-objects\/([^/]+)$/u)
      if (request.method === 'PUT' && objectMatch) {
        objects.set(decodeURIComponent(objectMatch[1]), await rawBody(request))
        response.writeHead(200)
        response.end()
        return true
      }
      if (request.method === 'GET' && objectMatch) {
        const object = objects.get(decodeURIComponent(objectMatch[1]))
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(object)
        return true
      }
      const commitMatch = url.pathname.match(/^\/api\/wework-transcripts\/([^/]+)\/segments$/u)
      if (request.method === 'POST' && commitMatch) {
        const transcriptId = decodeURIComponent(commitMatch[1])
        const body = await requestBody(request)
        const transcript = transcripts.get(transcriptId)
        const objectId = `${transcriptId}-${body.sequence}-${body.sha256}`
        const object = objects.get(objectId)
        assert.ok(object, 'Segment metadata committed before object upload')
        assert.equal(object.byteLength, body.sizeBytes)
        assert.equal(createHash('sha256').update(object).digest('hex'), body.sha256)
        const existing = transcript.archives.find(archive => archive.toSequence === body.sequence)
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
          transcript.currentSequence = body.sequence
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
      const releaseMatch = url.pathname.match(
        /^\/api\/wework-transcripts\/([^/]+)\/lease\/release$/u
      )
      if (request.method === 'POST' && releaseMatch) {
        const body = await requestBody(request)
        assert.deepEqual({ clientId: body.clientId, fencingToken: body.fencingToken }, lease)
        lease = null
        json(response, 200, { released: true })
        return true
      }
      const downloadMatch = url.pathname.match(
        /^\/api\/wework-transcripts\/([^/]+)\/archives\/(\d+)\/download$/u
      )
      if (request.method === 'GET' && downloadMatch) {
        const transcript = transcripts.get(decodeURIComponent(downloadMatch[1]))
        const archive = transcript.archives.find(item => item.id === Number(downloadMatch[2]))
        json(response, 200, {
          downloadUrl: `${origin}/transcript-objects/${encodeURIComponent(archive.objectId)}`,
        })
        return true
      }
      if (request.method === 'POST' && ['/responses', '/v1/responses'].includes(url.pathname)) {
        const body = await requestBody(request)
        modelRequests.push(structuredClone(body))
        const serialized = JSON.stringify(body)
        const completion = serialized.includes(THIRD_PROMPT)
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
        () => lease === null && sqliteOutboxCount(deviceAOutboxPath) === 0,
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'Restart did not reconcile the already committed native snapshot'
      )
      assert.equal(activeTranscript().archives[0].format, 'codex-rollout-snapshot.v1.tgz.aes256gcm')
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
          lease === null,
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'Second turn did not upload a native rollout delta'
      )
      assert.equal(activeTranscript().archives[1].format, 'codex-rollout-delta.v1.tgz.aes256gcm')
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
      await control.command('click', `[data-testid="runtime-local-task-row-${transcriptId}"]`)
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
        text: '同步已开启',
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

      await control.command('click', '[data-testid="transcript-sync-enabled-checkbox"]')
      await control.command('waitFor', '[data-testid="transcript-sync-enabled-status"]', {
        text: '同步已开启',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="settings-back-button"]')
      await waitFor(
        () =>
          activeTranscript().currentSequence === 4 && sqliteOutboxCount(deviceBOutboxPath) === 0,
        uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        'Re-enabled sync did not upload the queued native delta'
      )
      const persisted = JSON.parse(await readFile(deviceBStatePath, 'utf8'))
      assert.equal(Object.hasOwn(persisted.transcripts[activeTranscriptId], 'turns'), false)
      assert.ok((await readFile(deviceAStatePath, 'utf8')).includes(activeTranscriptId))
      await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('click', '[data-testid="settings-button"]')
      await control.command('click', '[data-testid="settings-menu-button"]')
      await control.command('click', '[data-testid="settings-nav-connections"]')
      await control.command('waitFor', '[data-testid="transcript-sync-enabled-status"]', {
        text: '同步已开启',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(
        control,
        'transcript-sync-06-device-b-sync-reenabled-flushed.png',
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
