import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'
import { fetchJson, selectE2EModel } from '../modules/shared.mjs'
import { openStandInSettings } from '../modules/stand-in-profile-navigation.mjs'
import { readStandInBinding } from '../modules/stand-in-instance-flows.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'

const legacyPrompt = 'Keep the local assistant instructions'
const conversationPrompt = 'VERIFY_LOCAL_EXECUTION_AFTER_ASSISTANT_MIGRATION'
const modelReply = 'LOCAL_EXECUTION_AFTER_ASSISTANT_MIGRATION_CONFIRMED'
const peerPrompt = 'VERIFY_ASSISTANT_SEND_FROM_OTHER_DESKTOP'
const peerReply = 'EXECUTED_ON_ASSISTANT_OWNER_DESKTOP'
const primaryTask = 'stand-in-chat-1-primary'
const composer = '[data-testid="collaboration-exp-assistant-input"]'

export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs }) {
  let cloud
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const readCloudAssistant = async () =>
    (
      await fetchJson(`${cloud.backendUrl}/api/v1/personal-assistant`, {
        headers: { Authorization: `Bearer ${cloud.authToken}` },
        signal: AbortSignal.timeout(uiTimeoutMs),
      })
    ).assistant
  return {
    requiresCloudEnvironment: true,
    remoteExecutorType: 'app',
    verifiesStandInAccountMigration: true,
    verifiesStandInOnboarding: true,
    setCloudEnvironment(environment) {
      cloud = environment
    },
    async handleHttp(req, res, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      const input = JSON.stringify(body.input ?? [])
      const reply = input.includes(peerPrompt)
        ? peerReply
        : input.includes(conversationPrompt)
          ? modelReply
          : null
      if (!reply) return false
      const id = reply
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(createSse([responseCreated(id), assistantMessage(reply), responseCompleted(id)]))
      return true
    },
    async verify(control) {
      const { deviceId } = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
      const before = await readStandInBinding(control, uiTimeoutMs)
      assert.equal(before.status, 'unbound', 'The fixture should have no instance binding')
      assert.equal(
        await readCloudAssistant(),
        null,
        'The cloud account must start without an assistant'
      )
      const legacy = await rpc(control, 'runtime.stand_in.personal.get', { userId: 0 })
      await rpc(control, 'runtime.stand_in.personal.save', {
        userId: 0,
        settings: {
          ...legacy,
          primary: { enabled: true, prompt: legacyPrompt, preferences: '' },
        },
      })
      await rpc(control, 'runtime.stand_in.onboarding.complete', {
        userId: 1,
        weeklyReview: false,
        language: 'zh-CN',
      })

      await ensureExperimentalFeaturesEnabled(control)
      await control.command('setAppPreferences', 'body', {
        value: JSON.stringify({ collaborationExperienceEnabled: true }),
      })
      await control.command('navigate', 'body', { value: '/stand-in' })
      const confirmMigration = '[data-testid="personal-assistant-account-migrate-confirm"]'
      await control.command('waitFor', confirmMigration, { timeoutMs: uiTimeoutMs })
      assert.equal(
        await readCloudAssistant(),
        null,
        'Opening My assistants must wait for migration confirmation'
      )
      assert.equal(
        await control.command('getElementCount', composer),
        '0',
        'Chat must wait for migration'
      )

      await control.command('clickWhenEnabled', confirmMigration, { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', composer, { timeoutMs: uiTimeoutMs })
      const assistant = await readCloudAssistant()
      const primary = assistant.definitions.find(definition => definition.roleId === '@primary')
      assert.equal(primary.team.spec.collaborationModel, 'solo')
      assert.equal(primary.team.spec.members.length, 1)
      assert.equal(assistant.defaultTeamRef.name, primary.team.metadata.name)
      assert.equal(
        primary.ghost.spec.systemPrompt,
        legacyPrompt,
        'Migration must import the local instructions'
      )
      assert.equal(
        primary.bot.spec.execution_policy.environment_id,
        deviceId,
        'The imported assistant must keep the local executor'
      )
      assert.deepEqual(
        await readStandInBinding(control, uiTimeoutMs),
        before,
        'Migration must leave the instance unbound'
      )
      assert.equal(
        await control.command('getElementCount', '[data-testid="stand-in-migration"]'),
        '0',
        'Importing the profile must not prompt for a second device migration'
      )

      await selectE2EModel(control, undefined, undefined, '[data-testid="stand-in-experience"]')
      await control.command('fill', composer, { value: conversationPrompt })
      await control.command(
        'clickWhenEnabled',
        '[data-testid="collaboration-exp-assistant-send"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', '[data-testid="collaboration-exp-assistant-conversation"]', {
        text: modelReply,
        timeoutMs: modelResponseTimeoutMs,
      })
      const threadOnB = await waitForCompletedRuntimeTaskThread(
        control,
        primaryTask,
        modelResponseTimeoutMs
      )
      const peer = (await cloud.devices()).find(
        item => item.app_device_id === cloud.remoteExecutorEnv.WEGENT_APP_IPC_DEVICE_ID
      )
      assert.ok(peer?.execution_target_id, 'Device A must register as a distinct desktop executor')
      const peerDevice = peer.execution_target_id
      assert.notEqual(peerDevice, deviceId)
      assert.equal(peer.runtime_features?.remoteTaskAccess?.enabled, true)
      const entries = [
        { roleId: '@primary', name: primary.team.metadata.displayName, prompt: legacyPrompt },
        { roleId: 'reviewer', name: 'Review assistant', prompt: 'Review changes.' },
        { roleId: 'triage', name: 'Triage assistant', prompt: 'Triage new work.' },
      ]
      await fetchJson(cloud.backendUrl + '/api/v1/personal-assistant', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + cloud.authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: assistant.revision,
          desired: {
            definitions: entries.map(entry => ({ ...entry, executionDeviceId: peerDevice })),
          },
        }),
        signal: AbortSignal.timeout(uiTimeoutMs),
      })
      await control.command('setAppPreferences', 'body', {
        value: JSON.stringify({ collaborationExperienceEnabled: false }),
      })
      await reloadMainWindow(control)
      await control.command('navigate', 'body', { value: '/stand-in' })
      await control.command('waitFor', '[data-testid="stand-in-primary-open"]', {
        timeoutMs: uiTimeoutMs,
      })
      for (const role of entries.slice(1)) {
        await control.command(
          'waitFor',
          '[data-testid="stand-in-overview-role-' + role.roleId + '"]',
          {
            text: role.name,
            timeoutMs: uiTimeoutMs,
          }
        )
      }
      await openStandInSettings(control)
      await control.command(
        'clickWhenEnabled',
        '[data-testid="stand-in-primary-execution-toggle"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', '[data-testid="personal-assistant-execution-device"]', {
        text: peer.name,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-profile-close"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="stand-in-profile-panel"]', {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      const peerConversation = '[data-testid="stand-in-conversation"]'
      await control.command('waitFor', peerConversation, { timeoutMs: uiTimeoutMs })
      await control.command('fill', peerConversation + ' [data-testid="chat-message-input"]', {
        value: peerPrompt,
      })
      await control.command(
        'clickWhenEnabled',
        peerConversation + ' [data-testid="send-message-button"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', peerConversation, {
        text: peerReply,
        timeoutMs: modelResponseTimeoutMs,
      })
      const peerIndex = join(dirname(cloud.remoteCodexHome), 'runtime-work/index.json')
      const threadOnA = await until(
        async () => JSON.parse(await readFile(peerIndex, 'utf8')).tasks[primaryTask]?.thread_id,
        Boolean,
        'Device A did not persist a Codex thread for the message sent from device B',
        modelResponseTimeoutMs
      )
      assert.notEqual(threadOnA, threadOnB)
      assert.equal(
        await waitForCompletedRuntimeTaskThread(control, primaryTask, uiTimeoutMs),
        threadOnB
      )

      await cloud.restartCloudExecutor({
        beforeSpawn: () =>
          writeFile(
            join(dirname(cloud.remoteCodexHome), 'remote-task-access.json'),
            JSON.stringify({ enabled: false })
          ),
      })
      await reloadMainWindow(control)
      await control.command('navigate', 'body', { value: '/stand-in' })
      await control.command('waitFor', '[data-testid="stand-in-overview-retry"]', {
        timeoutMs: uiTimeoutMs,
      })
      await openStandInSettings(control)
      const executionDevice = '[data-testid="personal-assistant-execution-device"]'
      await control.command('waitFor', executionDevice, { timeoutMs: uiTimeoutMs })
      assert.equal(
        (await readCloudAssistant()).definitions.find(role => role.roleId === '@primary').bot.spec
          .execution_policy.environment_id,
        peerDevice
      )
      await control.command('waitFor', '[data-testid="stand-in-profile-panel"]', {
        text: '已有对话和连接范围留在原设备',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clickWhenEnabled', executionDevice, { timeoutMs: uiTimeoutMs })
      await control.command(
        'clickWhenEnabled',
        '[role="listbox"] [role="option"][data-value=' + JSON.stringify(deviceId) + ']',
        { timeoutMs: uiTimeoutMs }
      )
      await until(
        readCloudAssistant,
        account =>
          account?.definitions.find(role => role.roleId === '@primary')?.bot.spec.execution_policy
            .environment_id === deviceId,
        'Device B could not update the cloud execution device with Device A access disabled',
        uiTimeoutMs
      )
    },
  }
}
