import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { stopProcessGroup } from '../process-lifecycle.mjs'
import { appendProcessOutput } from '../process-output.mjs'
import { DesktopE2EServer } from './desktop-server.mjs'
import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'
import { prepareNativeKeychainPreferences } from './native-keychain-preferences.mjs'
import { ensureExperimentalFeaturesEnabled } from './preferences-automation-flows.mjs'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import { bindStoppedStandIn } from './stand-in-instance-flows.mjs'
import { findRuntimeWorkTask } from './runtime-task-evidence.mjs'
import { until } from './plugin-regression-fixture.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'
import { CLOUD_DEVICE_ID, MODEL_API_KEY, weworkDir } from './shared.mjs'

export const PEER_CLOUD_PROMPT = 'PEER_CLIENT_CLOUD_PRIMARY_EXECUTION'
export const PEER_CLOUD_COMPLETE = 'PEER_CLIENT_CLOUD_PRIMARY_COMPLETE'
export const PEER_FALLBACK_PROMPT = 'PEER_CLIENT_FOREIGN_DESKTOP_FALLBACK_EXECUTION'
export const PEER_FALLBACK_COMPLETE = 'PEER_CLIENT_FOREIGN_DESKTOP_FALLBACK_COMPLETE'
export const OFFLINE_SWITCH_PROMPT = 'OFFLINE_SELECTED_ASSISTANT_SWITCH_LOCAL'
export const OFFLINE_SWITCH_COMPLETE = 'OFFLINE_SELECTED_ASSISTANT_LOCAL_TURN_COMPLETE'
const testId = id => `[data-testid=${JSON.stringify(id)}]`

/** Own a second real desktop installation for the cloud-device checkpoint. */
export function createStandInCloudPeerClient({
  resultDir,
  workspacePath,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
  modelResponseTimeoutMs,
  userId,
}) {
  let preparedApp
  let peerControl
  let peerApp
  let peerStopping = false
  let peerSqliteHome

  async function stopPeerClient() {
    const activePeerApp = peerApp
    const activePeerControl = peerControl
    peerStopping = true
    try {
      if (Number.isInteger(activePeerApp?.pid)) await stopProcessGroup(activePeerApp)
      peerApp = null
    } finally {
      if (activePeerControl) await activePeerControl.close()
      peerControl = null
    }
  }

  return {
    async prepareApp({ appBinary, appEnvironment, codexHome }) {
      // Prepare a fresh peer before the first client starts. Only copy the runner's static
      // fixture configuration; live Codex databases, credentials and session files stay private.
      const peerRoot = join(resultDir, 'peer-desktop-client')
      const peerHome = join(peerRoot, 'home')
      const peerUserData = join(peerRoot, 'user-data')
      const peerExecutorHome = join(peerRoot, 'executor-home')
      const peerCodexHome = join(peerExecutorHome, 'codex')
      peerSqliteHome = join(dirname(appEnvironment.CODEX_SQLITE_HOME), 'peer-codex-sqlite')
      await Promise.all(
        [peerHome, peerUserData, peerCodexHome, peerSqliteHome].map(path =>
          mkdir(path, { recursive: true, mode: 0o700 })
        )
      )
      await prepareNativeKeychainPreferences(peerHome)
      await Promise.all([
        copyFile(join(codexHome, 'config.toml'), join(peerCodexHome, 'config.toml')),
        writeFile(
          join(peerCodexHome, 'auth.json'),
          `${JSON.stringify({ OPENAI_API_KEY: MODEL_API_KEY })}\n`,
          { mode: 0o600 }
        ),
        copyFile(
          join(appEnvironment.WEWORK_USER_DATA_DIR, 'app-preferences.json'),
          join(peerUserData, 'app-preferences.json')
        ),
        copyFile(
          join(appEnvironment.WEWORK_USER_DATA_DIR, 'renderer-local-storage.json'),
          join(peerUserData, 'renderer-local-storage.json')
        ),
        writeFile(join(peerHome, '.zshrc'), '# Wework desktop E2E shell\n'),
      ])
      preparedApp = {
        appBinary,
        appLogPath: join(peerRoot, 'app.log'),
        appEnvironment: {
          ...appEnvironment,
          WEWORK_APP_IDENTIFIER: `${appEnvironment.WEWORK_APP_IDENTIFIER}.peer`,
          HOME: peerHome,
          WORKSPACE_ROOT: join(peerHome, '.wegent', 'workspace'),
          WEGENT_STANDALONE_WORKSPACE_ROOT: join(peerHome, 'Documents', 'Codex'),
          WEWORK_USER_DATA_DIR: peerUserData,
          WEGENT_EXECUTOR_HOME: peerExecutorHome,
          CODEX_HOME: peerCodexHome,
          WEGENT_CODEX_HOME: peerCodexHome,
          CODEX_SQLITE_HOME: peerSqliteHome,
          WEGENT_EXECUTOR_LOG_DIR: peerRoot,
          WEGENT_EXECUTOR_LOG_FILE: 'executor.log',
          WEWORK_APP_CONFIG_DIR: join(peerHome, 'app-config'),
          WEWORK_DESKTOP_CONTROL_REGISTRY_DIR: join(peerRoot, 'desktop-control'),
          WEWORK_E2E_SAVE_DIALOG_PATH: join(peerRoot, 'conversation-export-e2e.zip'),
          WEWORK_E2E_STARTUP_SPLASH_CAPTURE: join(peerRoot, 'startup-splash.png'),
        },
      }
    },
    async cleanup() {
      await stopPeerClient()
      if (peerSqliteHome) await rm(peerSqliteHome, { recursive: true, force: true })
    },
    async verify(
      control,
      localDevice,
      {
        cloud,
        rpc,
        remoteRpc,
        readCloudAssistant,
        readPrimaryDevice,
        setPrimaryDevice,
        stop,
        observeDevice,
        sendChat,
        localPrimaryThreadId,
      }
    ) {
      const primaryTaskId = `stand-in-chat-${userId}-primary`
      const primaryConversation = testId('stand-in-conversation')
      async function verifySavedLocalBinding(control, localDevice) {
        await setPrimaryDevice(localDevice)
        await rpc(control, 'runtime.stand_in.personal.lifecycle', {
          userId: userId,
          operation: 'start',
        })
        await reloadMainWindow(control)
        await control.command('waitFor', testId('stand-in-overview'))
        assert.equal(await readPrimaryDevice(), localDevice)
        // Both current sha256 and legacy UUID desktop electron-* IDs from another client must fall back
        // cleanly on this client without overwriting the saved cloud setting.
        for (const foreignDesktopDevice of [
          `electron-${'f'.repeat(64)}`,
          `electron-${randomUUID()}`,
        ]) {
          await setPrimaryDevice(foreignDesktopDevice)
          await reloadMainWindow(control)
          await control.command('clickWhenEnabled', testId('stand-in-primary-open'))
          // This reply was persisted only on the local Executor while the selected
          // cloud device was offline. Reopening it verifies the effective source.
          await control.command('waitFor', primaryConversation, {
            text: OFFLINE_SWITCH_COMPLETE,
            timeoutMs: uiTimeoutMs,
          })
          await control.command(
            'waitFor',
            `${primaryConversation} [data-testid="chat-message-input"]`,
            {
              enabled: true,
              timeoutMs: uiTimeoutMs,
            }
          )
          assert.equal(await readPrimaryDevice(), foreignDesktopDevice)
        }
        await setPrimaryDevice(localDevice)
      }

      async function verifyDeviceTurn(request, taskId, prompt, completion, owner) {
        const transcript = await until(
          () => request('runtime.tasks.transcript', { taskId, limit: 20, refresh: true }),
          value => {
            const user = value.messages?.find(
              message => message.role === 'user' && message.content === prompt
            )
            return Boolean(
              user?.turnId &&
              value.messages.some(
                message =>
                  message.role === 'assistant' &&
                  message.content?.includes(completion) &&
                  message.turnId === user.turnId
              )
            )
          },
          `${owner} must persist the new request and response in the same turn: ${prompt}`,
          modelResponseTimeoutMs
        )
        const finished = await until(
          () => request('runtime.tasks.get', { taskId }),
          result => result.task?.status === 'done' && result.task.running === false,
          `${owner} must finish the new turn: ${prompt}`,
          modelResponseTimeoutMs
        )
        assert.ok(transcript.threadId, `${owner} transcript must expose a native thread`)
        assert.equal(finished.task.threadId, transcript.threadId)
        const turnId = transcript.messages.find(
          message => message.role === 'user' && message.content === prompt
        ).turnId
        return { turnId, threadId: transcript.threadId }
      }

      async function verifyPeerCloudTurn(taskId, prompt, completion) {
        const turn = await verifyDeviceTurn(remoteRpc, taskId, prompt, completion, 'Cloud Executor')
        const peerLocalTasks = await rpc(peerControl, 'runtime.tasks.list', {})
        assert.equal(peerLocalTasks.coverage.authorized_index_complete, true)
        assert.equal(
          findRuntimeWorkTask(peerLocalTasks, taskId),
          undefined,
          'Cloud @primary chat must not execute on the second client local Executor'
        )
        return turn
      }

      assert.ok(preparedApp, 'Multi-client stand-in E2E requires prepared desktop launch metadata')
      peerControl = new DesktopE2EServer(workspacePath)
      const launchedPeerControl = peerControl
      peerStopping = false
      try {
        await peerControl.start({ modelPort: 0, controlPort: 0 })
        const peerEnv = {
          ...preparedApp.appEnvironment,
          WEWORK_E2E_CONTROL_URL: peerControl.controlUrl,
        }
        peerApp = spawn(preparedApp.appBinary, resolveElectronLaunchArguments(), {
          cwd: weworkDir,
          env: peerEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        })
        appendProcessOutput(peerApp.stdout, preparedApp.appLogPath, peerApp)
        appendProcessOutput(peerApp.stderr, preparedApp.appLogPath, peerApp)
        peerApp.once('error', error => {
          if (!peerStopping) launchedPeerControl.fail(error)
        })
        peerApp.once('exit', (code, signal) => {
          if (!peerStopping) {
            launchedPeerControl.fail(
              new Error(`Second desktop exited (code=${code}, signal=${signal})`)
            )
          }
        })
        peerControl.applicationProcessId = peerApp.pid
        await peerControl.awaitReadyAfter(0, workbenchReadyTimeoutMs)
        await peerControl.command('setCloudSessionToken', 'body', { value: cloud.authToken })
        await rpc(peerControl, 'runtime.stand_in.onboarding.complete', {
          userId: userId,
          weeklyReview: false,
          language: 'zh-CN',
        })
        await ensureExperimentalFeaturesEnabled(peerControl)
        await peerControl.command('setAppPreferences', 'body', {
          value: JSON.stringify({ collaborationExperienceEnabled: false }),
        })
        const peerIdentity = JSON.parse(await peerControl.command('getLocalExecutorStatus', 'body'))
        const peerDevice = peerIdentity.deviceId
        assert.notEqual(
          peerDevice,
          localDevice,
          'The second desktop client must have an independent local Executor identity'
        )

        // Exercise the existing offline recovery on both signed-in desktop installations.
        await stopProcessGroup(cloud.remoteExecutor)
        await cloud.waitForDeviceStatus(CLOUD_DEVICE_ID, 'offline', cloud.remoteExecutorLogPath)
        await observeDevice(control, CLOUD_DEVICE_ID, '离线')
        await reloadMainWindow(control)
        assert.equal(await readPrimaryDevice(), CLOUD_DEVICE_ID)
        await bindStoppedStandIn(control, userId, localDevice, uiTimeoutMs, cloud)
        await control.command('clickWhenEnabled', testId('stand-in-primary-open'))
        await control.command('waitFor', primaryConversation)
        await sendChat(control, primaryConversation, OFFLINE_SWITCH_PROMPT)
        await control.command('waitFor', primaryConversation, {
          text: OFFLINE_SWITCH_COMPLETE,
          timeoutMs: modelResponseTimeoutMs,
        })
        const offlineTurn = await verifyDeviceTurn(
          (method, params) => rpc(control, method, params),
          primaryTaskId,
          OFFLINE_SWITCH_PROMPT,
          OFFLINE_SWITCH_COMPLETE,
          'Local Executor'
        )
        assert.equal(offlineTurn.threadId, localPrimaryThreadId)
        assert.equal(await readPrimaryDevice(), localDevice)

        // Return to the offline device before exercising the shared pending stop.
        await setPrimaryDevice(CLOUD_DEVICE_ID)
        await reloadMainWindow(control)
        await control.command('clickWhenEnabled', testId('stand-in-instance-stop'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('clickWhenEnabled', testId('stand-in-instance-stop-confirm'))
        await control.command('waitFor', testId('stand-in-instance-stop') + ':not(:disabled)')
        await reloadMainWindow(control)
        await control.command('waitFor', testId('stand-in-instance-stopping'))
        const pending = (await readCloudAssistant()).assistant?.stopIntents?.find(
          intent => intent.deviceId === CLOUD_DEVICE_ID
        )
        assert.ok(pending?.requestId, 'The account must retain the offline stop request')
        assert.equal(await readPrimaryDevice(), CLOUD_DEVICE_ID)
        assert.equal(
          await control.command(
            'getElementCount',
            testId(`stand-in-instance-bind-0-${localDevice}`)
          ),
          '0',
          'Offline cancellation must not expose a legacy owner-zero binding'
        )
        await observeDevice(peerControl, CLOUD_DEVICE_ID, '离线')
        await reloadMainWindow(peerControl)
        await peerControl.command('waitFor', testId('stand-in-instance-stopping'))
        await cloud.restartCloudExecutor()
        await observeDevice(control, CLOUD_DEVICE_ID, '在线')
        await control.command('waitFor', testId('stand-in-instance-stopping'))
        await observeDevice(peerControl, CLOUD_DEVICE_ID, '在线')
        await peerControl.command('waitFor', testId('stand-in-instance-stopping'))
        await stop(peerControl)
        await reloadMainWindow(control)
        await control.command('waitFor', testId('stand-in-instance-stopped'))
        await until(
          async () => (await readCloudAssistant()).assistant,
          account =>
            Boolean(
              account && !account.stopIntents?.some(intent => intent.deviceId === CLOUD_DEVICE_ID)
            ),
          'Peer stop acknowledgement clears the account marker',
          uiTimeoutMs
        )
        await verifySavedLocalBinding(control, localDevice)

        // 1. Both clients signed into the same fixture account share the cloud @primary device and execute on remoteHome.
        await setPrimaryDevice(CLOUD_DEVICE_ID)
        await remoteRpc('runtime.stand_in.personal.lifecycle', {
          userId: userId,
          operation: 'start',
        })
        await Promise.all([
          (async () => {
            await control.command('navigate', 'body', { value: '/stand-in' })
            await reloadMainWindow(control)
            await control.command('clickWhenEnabled', testId('stand-in-primary-open'))
            await control.command('waitFor', testId('stand-in-conversation'))
          })(),
          (async () => {
            await peerControl.command('navigate', 'body', { value: '/stand-in' })
            await reloadMainWindow(peerControl)
            await peerControl.command('clickWhenEnabled', testId('stand-in-primary-open'))
            await peerControl.command('waitFor', testId('stand-in-conversation'))
          })(),
        ])
        await sendChat(peerControl, testId('stand-in-conversation'), PEER_CLOUD_PROMPT)
        await peerControl.command('waitFor', testId('stand-in-conversation'), {
          text: PEER_CLOUD_COMPLETE,
          timeoutMs: modelResponseTimeoutMs,
        })
        const cloudTurn = await verifyPeerCloudTurn(
          primaryTaskId,
          PEER_CLOUD_PROMPT,
          PEER_CLOUD_COMPLETE
        )
        assert.notEqual(
          cloudTurn.threadId,
          localPrimaryThreadId,
          'The cloud primary conversation must have a different native thread from the local primary'
        )
        await reloadMainWindow(control)
        await control.command('clickWhenEnabled', testId('stand-in-primary-open'))
        await control.command('waitFor', testId('stand-in-conversation'), {
          text: PEER_CLOUD_COMPLETE,
          timeoutMs: uiTimeoutMs,
        })

        // 2. Stop confirmation race: opening stop confirm on client 1 while client 2 switches @primary to localDevice
        // must refuse stopping the newly selected device.
        const cloudProfileBefore = await remoteRpc('runtime.stand_in.personal.get', {
          userId: userId,
        })
        const localProfileBefore = await rpc(control, 'runtime.stand_in.personal.get', {
          userId: userId,
        })
        assert.equal(cloudProfileBefore.lifecycle, undefined)
        assert.equal(localProfileBefore.lifecycle, undefined)
        await openStandInSettings(control)
        await control.command('clickWhenEnabled', testId('stand-in-instance-stop'))
        await control.command('waitFor', testId('stand-in-instance-stop-confirm'))
        await setPrimaryDevice(localDevice)
        await control.command('clickWhenEnabled', testId('stand-in-instance-stop-confirm'))
        await control.command('waitFor', testId('stand-in-instance-stop-confirm'), {
          visible: false,
        })
        // The rejected stale confirmation refreshes the account onto another device.
        // Wait for the old settings panel to unmount before opening the new profile.
        await control.command('waitFor', testId('stand-in-profile-panel'), {
          visible: false,
          timeoutMs: uiTimeoutMs,
        })
        await control.command('clickWhenEnabled', testId('stand-in-primary-open'))
        await openStandInSettings(control)
        await control.command('clickWhenEnabled', testId('stand-in-primary-execution-toggle'))
        await control.command('waitFor', testId('personal-assistant-execution-device'), {
          text: '当前设备',
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', testId('stand-in-instance-stop'), {
          enabled: true,
          text: '停止助理',
        })
        assert.deepEqual(
          (await remoteRpc('runtime.stand_in.personal.get', { userId: userId })).lifecycle,
          cloudProfileBefore.lifecycle,
          'Stale stop confirmation must not stop the cloud device after another client switched devices'
        )
        assert.deepEqual(
          (await rpc(control, 'runtime.stand_in.personal.get', { userId: userId })).lifecycle,
          localProfileBefore.lifecycle,
          'Stale stop confirmation must not stop the newly selected local device'
        )
        await control.command('clickWhenEnabled', testId('stand-in-primary-profile-close'))
        await control.command('waitFor', testId('stand-in-profile-panel'), { visible: false })

        // 3. While @primary points to client 1's private localDevice, client 2 (simultaneously signed in)
        // falls back cleanly to CLOUD_DEVICE_ID without overwriting cloud @primary and executes on CLOUD_DEVICE_ID.
        await reloadMainWindow(peerControl)
        await peerControl.command('clickWhenEnabled', testId('stand-in-primary-open'))
        await peerControl.command('waitFor', testId('stand-in-conversation'))
        assert.equal(
          await readPrimaryDevice(),
          localDevice,
          'Second client fallback must not overwrite client 1 private desktop primary setting'
        )
        await sendChat(peerControl, testId('stand-in-conversation'), PEER_FALLBACK_PROMPT)
        await peerControl.command('waitFor', testId('stand-in-conversation'), {
          text: PEER_FALLBACK_COMPLETE,
          timeoutMs: modelResponseTimeoutMs,
        })
        const fallbackTurn = await verifyPeerCloudTurn(
          primaryTaskId,
          PEER_FALLBACK_PROMPT,
          PEER_FALLBACK_COMPLETE
        )
        assert.notEqual(
          fallbackTurn.turnId,
          cloudTurn.turnId,
          'Fallback must execute a distinct cloud turn'
        )
        assert.equal(await readPrimaryDevice(), localDevice)
      } finally {
        await stopPeerClient()
      }
    },
  }
}
