import { TranscriptBackendEvidence } from '../modules/transcript-backend-evidence.mjs'
import { nativeCloudAuthorizationFixture } from '../modules/native-cloud-authorization-client.mjs'
import { readRequestBody as requestBody } from '../modules/response-protocol.mjs'
import assert from 'node:assert/strict'
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

async function sendTranscriptPrompt(control, prompt, timeoutMs) {
  await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: prompt })
  // A restored editor can mount before its model selection is ready to submit.
  await control.command(
    'waitFor',
    '[data-testid="desktop-workbench-main"] [data-testid="send-message-button"]',
    { enabled: true, timeoutMs }
  )
  await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
}

async function poll(predicate, timeoutMs, message) {
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

export function createDesktopScenario({
  captureScreenshot,
  electronUserDataDirectory,
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
  workspacePath,
}) {
  const transcripts = new Map()
  const objects = new Map()
  const segmentUploadCounts = new Map()
  const requestLog = []
  const modelRequests = []
  const leases = new Map()
  const appEnvironment = {}
  const authorizations = []
  let evidence
  let cloud
  let activeTranscriptId = null
  let firstCommitResponseDropped = false
  let restartDesktopApp = null
  let modelSequence = 0
  async function authorizeUserData(directory, control) {
    const fixture = nativeCloudAuthorizationFixture(
      { backendUrl: evidence.proxy.url, authToken: cloud.authToken },
      directory,
      control
    )
    authorizations.push(fixture)
    await fixture.authorize()
  }
  async function waitFor(predicate, timeoutMs, message) {
    return poll(
      async () => {
        await evidence.refresh()
        activeTranscriptId ??= evidence.activeTranscriptId
        firstCommitResponseDropped = evidence.firstCommitResponseDropped
        return predicate()
      },
      timeoutMs,
      message
    )
  }

  function activeTranscript() {
    assert.ok(activeTranscriptId, 'The active transcript ID was not observed')
    return transcripts.get(activeTranscriptId)
  }

  return {
    appEnvironment,
    requiresNativeCloudInspector: true,
    setCloudEnvironment(environment) {
      cloud = environment
    },
    async prepareApp({ appEnvironment: environment }) {
      evidence = await new TranscriptBackendEvidence(cloud).start()
      evidence.transcripts = transcripts
      evidence.objects = objects
      evidence.segmentUploadCounts = segmentUploadCounts
      evidence.requestLog = requestLog
      evidence.leases = leases
      environment.WEWORK_BACKEND_URL = evidence.proxy.url + '/api'
      environment.WEWORK_E2E_CLOUD_BACKEND_URL = evidence.proxy.url
    },
    async cleanup() {
      try {
        for (const authorization of authorizations) await authorization.restore()
      } finally {
        await evidence?.stop()
      }
    },
    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },
    async handleHttp(request, response, url) {
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
      await authorizeUserData(electronUserDataDirectory, control)
      const transcriptRequestCount = () =>
        requestLog.filter(value => value.includes('/api/wework-transcripts')).length
      const enableTranscriptSync = async ({ verifyExperimentalGate = false } = {}) => {
        const requestsBeforeOptIn = transcriptRequestCount()
        const experimentalToggle = '[data-testid="general-experimental-features-toggle"]'

        await control.command('click', '[data-testid="settings-button"]')
        await control.command('click', '[data-testid="settings-menu-button"]')
        await control.command('waitFor', experimentalToggle, { timeoutMs: uiTimeoutMs })
        const experimentalEnabled =
          (await control.command('getAttribute', experimentalToggle, {
            value: 'aria-checked',
          })) === 'true'

        if (verifyExperimentalGate) {
          assert.equal(experimentalEnabled, false)
          await control.command('click', '[data-testid="settings-nav-connections"]')
          assert.equal(
            Number(
              await control.command(
                'getElementCount',
                '[data-testid="transcript-sync-settings-section"]',
                { visible: true }
              )
            ),
            0,
            'Transcript sync must stay hidden until experimental features are enabled'
          )
          assert.equal(transcriptRequestCount(), requestsBeforeOptIn)
          await control.command('click', '[data-testid="settings-nav-general"]')
          await control.command('waitFor', experimentalToggle, { timeoutMs: uiTimeoutMs })
        }

        if (!experimentalEnabled) {
          await control.command('click', experimentalToggle)
          await waitFor(
            async () =>
              (await control.command('getAttribute', experimentalToggle, {
                value: 'aria-checked',
              })) === 'true',
            uiTimeoutMs,
            'Experimental features were not enabled'
          )
        }

        await control.command('click', '[data-testid="settings-nav-connections"]')
        await control.command('waitFor', '[data-testid="transcript-sync-enabled-status"]', {
          text: '同步已关闭',
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(
          transcriptRequestCount(),
          requestsBeforeOptIn,
          'Transcript sync contacted the cloud before explicit opt-in'
        )
        await control.command('click', '[data-testid="transcript-sync-enabled-checkbox"]')
        await control.command('waitFor', '[data-testid="transcript-sync-enabled-status"]', {
          text: '同步正常',
          timeoutMs: uiTimeoutMs + SYNC_POLL_INTERVAL_MS,
        })
        await control.command('click', '[data-testid="settings-back-button"]')
      }

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
      await control.command('waitFor', '[data-testid="settings-button"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await enableTranscriptSync({ verifyExperimentalGate: true })
      await createSingleRootLocalProject(control, workspacePath, 'transcript-sync')
      await writeFile(join(workspacePath, 'transcript-sync-restore-marker.txt'), 'snapshot\n')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await sendTranscriptPrompt(control, FIRST_PROMPT, uiTimeoutMs)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: FIRST_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await waitFor(
        () =>
          activeTranscriptId &&
          activeTranscript()?.currentSequence === 1 &&
          firstCommitResponseDropped &&
          objects.size === 0 &&
          sqliteOutboxCount(deviceAOutboxPath) === 1,
        uiTimeoutMs,
        'Native snapshot was not retained after its object disappeared with the commit response'
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
      const repairedSnapshotObjectId = activeTranscript().archives[0].objectId
      assert.equal(segmentUploadCounts.get(repairedSnapshotObjectId), 2)
      assert.ok(objects.get(repairedSnapshotObjectId)?.byteLength > 0)
      await captureScreenshot(control, 'transcript-sync-01-device-a-snapshot-uploaded.png', 'body')
      await evidence.deleteObject(repairedSnapshotObjectId)

      await writeFile(
        join(workspacePath, 'transcript-sync-restore-marker.txt'),
        `${RESTORED_WORKSPACE_MARKER}\n`
      )
      await sendTranscriptPrompt(control, SECOND_PROMPT, uiTimeoutMs)
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
        'Second turn did not replace the broken recovery chain with a native snapshot'
      )
      assert.equal(activeTranscript().archives[1].format, 'codex-snapshot.v1.tgz.aes256gcm')
      assert.equal(activeTranscript().turns[1].payload.assistantMessage, SECOND_COMPLETION)
      await captureScreenshot(
        control,
        'transcript-sync-02-device-a-repaired-snapshot-uploaded.png',
        'body'
      )
      assert.equal(objects.has(activeTranscript().archives[0].objectId), false)
      const repairedSnapshotObject = objects.get(activeTranscript().archives[1].objectId)
      assert.ok(repairedSnapshotObject.byteLength > 0)
      assert.equal(repairedSnapshotObject.subarray(0, 4).toString('ascii'), 'WTRN')
      assert.notDeepEqual([...repairedSnapshotObject.subarray(0, 2)], [0x1f, 0x8b])

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
      await authorizeUserData(deviceBUserDataDirectory, control)
      await control.command('waitFor', '[data-testid="telemetry-consent-overlay"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clickWhenEnabled', '[data-testid="telemetry-consent-decline"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await enableTranscriptSync({ verifyExperimentalGate: true })
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
      await sendTranscriptPrompt(control, RESTORED_PROMPT, uiTimeoutMs)
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
      assert.equal(
        activeTranscript().archives.find(archive => archive.toSequence === 3)?.format,
        'codex-snapshot.v1.tgz.aes256gcm'
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
      await sendTranscriptPrompt(control, THIRD_PROMPT, uiTimeoutMs)
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
      await authorizeUserData(deviceCUserDataDirectory, control)
      await control.command('waitFor', '[data-testid="telemetry-consent-overlay"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clickWhenEnabled', '[data-testid="telemetry-consent-decline"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await enableTranscriptSync({ verifyExperimentalGate: true })
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
      await sendTranscriptPrompt(control, REMOTE_PROMPT, uiTimeoutMs)
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
      const externalLease = await evidence.request(
        '/api/wework-transcripts/' + encodeURIComponent(transcriptId) + '/lease',
        {
          method: 'POST',
          body: JSON.stringify({ clientId: 'external-test-writer', ttlSeconds: 300 }),
        }
      )
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
      await evidence.request(
        '/api/wework-transcripts/' + encodeURIComponent(transcriptId) + '/lease/release',
        {
          method: 'POST',
          body: JSON.stringify({
            clientId: externalLease.clientId,
            fencingToken: externalLease.fencingToken,
          }),
        }
      )
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
      await sendTranscriptPrompt(control, NEW_CHAT_PROMPT, uiTimeoutMs)
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
      await sendTranscriptPrompt(control, OTHER_PROJECT_PROMPT, uiTimeoutMs)
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
      assert.equal(persisted.optInVersion, 1)
      assert.equal(persisted.enabled, true)
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
        segmentUploadCounts: Object.fromEntries(segmentUploadCounts),
        transcripts: Object.fromEntries(transcripts),
      }
    },
  }
}
