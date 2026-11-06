import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { stopProcessGroup } from '../process-lifecycle.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { findRuntimeWorkTask } from '../modules/runtime-task-evidence.mjs'
import { CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID, selectE2EModel } from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const USER = 1
const MULTIPLE = 'Cloud stand-in selected device'
const SINGLE = 'Cloud stand-in automatic device'
const PROMPT = 'CLOUD_STAND_IN_DEVICE_EXECUTION'
const COMPLETE = 'CLOUD_STAND_IN_DEVICE_EXECUTION_COMPLETE'
const LOCAL_NAME = 'Signed-out local stand-in'
const LOCAL_PROMPT = 'LOCAL_STAND_IN_DEVICE_HISTORY'
const LOCAL_COMPLETE = 'LOCAL_STAND_IN_HISTORY_PRESERVED'

function readRoles(home) {
  const database = new DatabaseSync(join(home, 'data/tasks.sqlite'), { readOnly: true })
  try {
    return database
      .prepare(
        "SELECT metadata FROM loop_items WHERE resource_type='personal_stand_in' AND json_extract(metadata,'$.userId')=?"
      )
      .all(USER)
      .flatMap(row => JSON.parse(row.metadata).roles)
  } finally {
    database.close()
  }
}

// User stories: select among real cloud devices, run remotely, auto-use the sole
// remaining device, and recover through Cloud work when all devices are offline.
export function createDesktopScenario({
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
  modelResponseTimeoutMs,
}) {
  let cloud
  let modelRequests = 0
  async function observeOffline(control, id) {
    await control.command('navigate', 'body', { value: '/cloud-work' })
    await control.command(
      'waitFor',
      `[data-testid="connection-device-${id}"] [data-testid="connection-device-status"]`,
      {
        text: '离线',
        timeoutMs: workbenchReadyTimeoutMs,
      }
    )
    await control.command('navigate', 'body', { value: '/stand-in' })
  }
  async function saveRole(control, name) {
    await control.command('fill', '[data-testid="stand-in-role-name"]', { value: name })
    await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
    await control.command('waitFor', '[data-testid="stand-in-profile-panel"]', { visible: false })
  }
  async function chooseLocalProfile(control) {
    await control.command('waitFor', '[data-testid="stand-in-workspace-location"]')
    await control.command('select', '[data-testid="stand-in-workspace-location"]', {
      value: '@local',
    })
  }
  async function chooseCreationDevice(control, deviceId) {
    await control.command('waitFor', '[data-testid="stand-in-role-name"]')
    await control.command('select', '[data-testid="stand-in-device"]', { value: deviceId })
    if (Number(await control.command('getElementCount', '[data-testid="stand-in-discard"]')))
      await control.command('clickWhenEnabled', '[data-testid="stand-in-discard"]')
    await control.command('waitFor', '[data-testid="stand-in-role-name"]')
  }
  return {
    requiresCloudEnvironment: true,
    setCloudEnvironment(value) {
      cloud = value
    },
    async handleHttp(req, res, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      const input = JSON.stringify(body.input ?? [])
      if (!input.includes(PROMPT) && !input.includes(LOCAL_PROMPT)) return false
      modelRequests++
      const id = `cloud-stand-in-${modelRequests}`
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.end(
        createSse([
          responseCreated(id),
          assistantMessage(input.includes(LOCAL_PROMPT) ? LOCAL_COMPLETE : COMPLETE),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      // First-use setup has its own CI checkpoint; establish completed setup for both owners.
      for (const userId of [0, USER]) {
        await requestExecutor(
          control,
          'runtime.stand_in.onboarding.complete',
          { userId, weeklyReview: false, language: 'zh-CN' },
          uiTimeoutMs
        )
      }
      const initial = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER },
        uiTimeoutMs
      )
      const remoteHome = dirname(cloud.remoteCodexHome)
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('navigate', 'body', { value: '/stand-in' })
      await control.command(
        'waitFor',
        '[data-testid="stand-in-onboarding-setup"] [data-testid="stand-in-device"]'
      )
      const firstUseDevice = await control.command(
        'getValue',
        '[data-testid="stand-in-onboarding-setup"] [data-testid="stand-in-device"]'
      )
      assert.ok(
        [CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID].includes(firstUseDevice),
        'First-use primary setup must default to a cloud device'
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-onboarding-continue"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-onboarding-complete"]')
      await control.command('waitFor', '[data-testid="stand-in-onboarding"]', { visible: false })
      await control.command('navigate', 'body', { value: '/settings/connections' })
      await control.command('clickWhenEnabled', '[data-testid="settings-cloud-disconnect-button"]')
      await control.command('waitFor', '[data-testid="settings-cloud-connect-button"]')
      await control.command('navigate', 'body', { value: '/stand-in' })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-create-role"]')
      await control.command('waitFor', '[data-testid="stand-in-role-name"]')
      await saveRole(control, LOCAL_NAME)
      const localBefore = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: 0 },
        uiTimeoutMs
      )
      const localRole = localBefore.roles.find(row => row.name === LOCAL_NAME)
      assert.ok(localRole, 'Signed-out creation must persist in the local owner profile')
      await control.command(
        'clickWhenEnabled',
        `[data-testid="stand-in-overview-role-${localRole.id}"]`
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-role-chat"]')
      const localChat = '[data-testid="stand-in-conversation"]'
      await selectE2EModel(control, undefined, undefined, localChat)
      await control.command('fill', `${localChat} [data-testid="chat-message-input"]`, {
        value: LOCAL_PROMPT,
      })
      await control.command('press', `${localChat} [data-testid="chat-message-input"]`, {
        key: 'Enter',
      })
      await control.command('waitFor', localChat, {
        text: LOCAL_COMPLETE,
        timeoutMs: modelResponseTimeoutMs,
      })
      // Reuse the existing authenticated real-Backend fixture; no application APIs are mocked.
      await control.command('setCloudSessionToken', 'body', { value: cloud.authToken })
      await control.command('navigate', 'body', { value: '/cloud-work' })
      await control.command('waitFor', `[data-testid="connection-device-${CLOUD_DEVICE_ID}"]`, {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('navigate', 'body', { value: '/stand-in' })
      await chooseLocalProfile(control)
      await control.command(
        'clickWhenEnabled',
        `[data-testid="stand-in-overview-role-${localRole.id}"]`
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-role-chat"]')
      await control.command('waitFor', localChat, { text: LOCAL_COMPLETE })
      assert.deepEqual(
        await requestExecutor(control, 'runtime.stand_in.personal.get', { userId: 0 }, uiTimeoutMs),
        localBefore
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-create-role"]')
      await control.command('waitFor', '[data-testid="stand-in-device"]')
      await control.command('waitFor', '[data-testid="stand-in-role-name"]')
      const defaultDevice = await control.command('getValue', '[data-testid="stand-in-device"]')
      assert.ok(
        [CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID].includes(defaultDevice),
        'An available cloud device must be selected by default'
      )
      const localIdentity = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
      await chooseCreationDevice(control, localIdentity.deviceId)
      await saveRole(control, 'Explicit local choice with cloud available')
      assert.ok(
        (
          await requestExecutor(
            control,
            'runtime.stand_in.personal.get',
            { userId: 0 },
            uiTimeoutMs
          )
        ).roles.some(row => row.name === 'Explicit local choice with cloud available')
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-create-role"]')
      await chooseCreationDevice(control, CLOUD_DEVICE_ID)
      await saveRole(control, MULTIPLE)
      const role = readRoles(remoteHome).find(row => row.name === MULTIPLE)
      assert.ok(role, 'The selected cloud Executor must persist the role')
      assert.equal(role.executionDeviceId, CLOUD_DEVICE_ID)
      assert.ok(
        !readRoles(remoteHome).some(row => row.id === localRole.id),
        'Local profiles must never be copied to the cloud'
      )
      await control.command('clickWhenEnabled', `[data-testid="stand-in-overview-role-${role.id}"]`)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-role-chat"]')
      const chat = '[data-testid="stand-in-conversation"]'
      await selectE2EModel(control, undefined, undefined, chat)
      await control.command('fill', `${chat} [data-testid="chat-message-input"]`, { value: PROMPT })
      await control.command('press', `${chat} [data-testid="chat-message-input"]`, { key: 'Enter' })
      await control.command('waitFor', chat, { text: COMPLETE, timeoutMs: modelResponseTimeoutMs })
      const taskId = `stand-in-chat-${USER}-role-${role.id}`
      const remoteIndex = JSON.parse(
        await readFile(join(remoteHome, 'runtime-work/index.json'), 'utf8')
      )
      assert.ok(
        remoteIndex.tasks[taskId]?.thread_id,
        'The real remote Executor must own the Codex conversation'
      )
      const localTasks = await requestExecutor(control, 'runtime.tasks.list', {}, uiTimeoutMs)
      assert.equal(localTasks.coverage.authorized_index_complete, true)
      assert.equal(
        findRuntimeWorkTask(localTasks.workspaces, taskId),
        undefined,
        'The local Executor must not own this conversation'
      )
      const memory = await requestExecutor(
        control,
        'runtime.stand_in.memory.save',
        {
          userId: 0,
          memory: {
            content: 'LOCAL_ROLE_MIGRATION_MEMORY',
            scope: { kind: 'role', roleId: localRole.id },
          },
        },
        uiTimeoutMs
      )
      await chooseLocalProfile(control)
      await control.command(
        'clickWhenEnabled',
        `[data-testid="stand-in-overview-role-${localRole.id}"]`
      )
      await control.command('waitFor', '[data-testid="stand-in-migration"]')
      await control.command('select', '[data-testid="stand-in-migration-device"]', {
        value: CLOUD_DEVICE_ID,
      })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-migrate-open"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-migrate-cancel"]')
      assert.ok(
        !readRoles(remoteHome).some(row => row.name === LOCAL_NAME),
        'Cancelling migration must not write to the cloud'
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-migrate-open"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-migrate-confirm"]')
      await control.command('waitFor', '[data-testid="stand-in-role-name"]')
      assert.equal(
        await control.command('getValue', '[data-testid="stand-in-role-name"]'),
        LOCAL_NAME
      )
      const migrated = readRoles(remoteHome).find(row => row.name === LOCAL_NAME)
      assert.ok(migrated, 'Confirmed migration must create the cloud copy')
      assert.equal(
        migrated.enabled,
        false,
        'The migrated cloud copy must wait for source configuration'
      )
      assert.ok(
        readRoles(remoteHome).some(row => row.id === role.id),
        'Migration must retain existing cloud roles'
      )
      const remoteDatabase = new DatabaseSync(join(remoteHome, 'data/tasks.sqlite'), {
        readOnly: true,
      })
      try {
        const rows = remoteDatabase
          .prepare(
            "SELECT metadata FROM loop_items WHERE resource_type='stand_in_memory' AND json_extract(metadata,'$.userId')=?"
          )
          .all(USER)
          .map(row => JSON.parse(row.metadata))
        assert.ok(
          rows.some(row => row.content === memory.content && row.scope.roleId === migrated.id),
          'Role memories must reach the target Executor'
        )
      } finally {
        remoteDatabase.close()
      }
      const retained = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: 0 },
        uiTimeoutMs
      )
      assert.ok(
        retained.roles.some(row => row.id === localRole.id),
        'Migration retains the local profile and history'
      )
      assert.ok(
        (
          await requestExecutor(control, 'runtime.stand_in.memory.list', { userId: 0 }, uiTimeoutMs)
        ).items.some(row => row.id === memory.id)
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-close"]')
      await control.command('waitFor', '[data-testid="stand-in-profile-panel"]', { visible: false })
      await chooseLocalProfile(control)
      await control.command(
        'clickWhenEnabled',
        `[data-testid="stand-in-overview-role-${localRole.id}"]`
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-role-chat"]')
      await control.command('waitFor', localChat, { text: LOCAL_COMPLETE })
      await cloud.stopRemoteDockerExecutorAndWaitOffline()
      await observeOffline(control, REMOTE_DOCKER_DEVICE_ID)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-create-role"]')
      await control.command('waitFor', '[data-testid="stand-in-role-name"]')
      assert.equal(
        await control.command('getElementCount', '[data-testid="stand-in-device"]'),
        '1',
        'The user can override the automatically selected cloud device'
      )
      assert.equal(
        await control.command('getValue', '[data-testid="stand-in-device"]'),
        CLOUD_DEVICE_ID
      )
      await saveRole(control, SINGLE)
      assert.equal(
        readRoles(remoteHome).find(row => row.name === SINGLE)?.executionDeviceId,
        CLOUD_DEVICE_ID
      )
      const local = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER },
        uiTimeoutMs
      )
      assert.deepEqual(local.roles, initial.roles, 'Cloud creation must preserve the local profile')
      await stopProcessGroup(cloud.remoteExecutor)
      await cloud.waitForDeviceStatus(CLOUD_DEVICE_ID, 'offline', cloud.remoteExecutorLogPath)
      await observeOffline(control, CLOUD_DEVICE_ID)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-create-role"]')
      await control.command('waitFor', '[data-testid="stand-in-role-name"]')
      const localStatus = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
      assert.equal(
        await control.command('getValue', '[data-testid="stand-in-device"]'),
        localStatus.deviceId
      )
      await saveRole(control, 'No cloud available local stand-in')
      assert.ok(
        (
          await requestExecutor(
            control,
            'runtime.stand_in.personal.get',
            { userId: USER },
            uiTimeoutMs
          )
        ).roles.some(row => row.name === 'No cloud available local stand-in')
      )
      await writeFile(
        join(resultDir, 'stand-in-cloud-device-evidence.json'),
        JSON.stringify({
          selectedDevice: CLOUD_DEVICE_ID,
          roleId: role.id,
          taskId,
          modelRequests,
          singleDevice: true,
          localDefaultWithoutCloud: true,
          migratedRoleId: migrated.id,
          localHistoryRetained: true,
        })
      )
    },
  }
}
