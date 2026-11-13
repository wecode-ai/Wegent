import assert from 'node:assert/strict'
import { openStandInActivity } from '../modules/stand-in-profile-navigation.mjs'
import { access, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assistantMessage,
  createSse,
  isReplyPredictionRequest,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import {
  shellCommandResponse,
  shellCommandRequestDiagnostic,
} from '../modules/shell-command-response.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { waitForSnapshot } from '../modules/conversation-layout.mjs'
import { fetchJson } from '../modules/shared.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import {
  bindStoppedStandIn,
  finishStandInOnboarding,
  stopBoundStandIn,
} from '../modules/stand-in-instance-flows.mjs'

const PROMPT = 'STAND_IN_VERIFY_EXPLICIT_WRITE_CONFIRMATION'
const DISPLAY_MESSAGE = '请在隔离工作区创建验证文件，执行前先让我确认。'
const ROOT = '[data-testid="stand-in-overview"]'
const CARD = '[data-testid="request-user-input-card"]'
const LIST = '[data-testid="stand-in-work-dialog"]'
const ROLE = 'approval-verification'

export function createDesktopScenario(options) {
  const { uiTimeoutMs, modelResponseTimeoutMs, workspacePath, captureScreenshot } = options
  const file = join(workspacePath, 'stand-in-approved.txt')
  let failedShellRequest = null
  let cloud
  let userId
  async function createWork(control, taskId) {
    const settings = await requestExecutor(
      control,
      'runtime.stand_in.personal.get',
      { userId },
      uiTimeoutMs
    )
    assert.ok(settings.roles.some(role => role.id === ROLE))
    const catalog = await requestExecutor(control, 'runtime.runner.catalog', {}, uiTimeoutMs)
    const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
    assert.ok(model)
    const origin = {
      type: 'stand_in_verification',
      initiatedBy: 'stand_in',
      userId,
      standInId: ROLE,
      deviceId: settings.executionDeviceId,
      askBeforeAct: true,
    }
    await requestExecutor(
      control,
      'runtime.tasks.create',
      {
        taskId,
        title: '操作前确认验证',
        runtime: 'codex',
        workspacePath,
        message: DISPLAY_MESSAGE,
        clientUserMessageId: 'stand-in-confirmation-initial',
        restoreUserMessageContent: true,
        origin,
        executionRequest: {
          task_id: taskId,
          subtask_id: `${taskId}-initial`,
          user_id: userId,
          prompt: taskId === 'stand-in-composer-decline' ? `${PROMPT} DECLINE_EXPECTED` : PROMPT,
          new_session: true,
          bot: [{ shell_type: 'Codex', name: 'Confirmation verification' }],
          model_config: { model_id: model.local_model_id, model_provider: model.provider },
          origin,
        },
        modelSelection: {
          modelName: model.local_model_id,
          modelType: 'runtime',
          options: { runnerModelProvider: model.provider },
        },
      },
      uiTimeoutMs
    )

    return ROLE
  }
  async function openList(control, roleId, taskId) {
    await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
    await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
    await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
    await control.command('waitFor', ROOT)
    await control.command('clickWhenEnabled', `[data-testid="stand-in-overview-role-${roleId}"]`, {
      visible: true,
      timeoutMs: uiTimeoutMs,
    })
    await openStandInActivity(control)
    await control.command('waitFor', `[data-testid="stand-in-activity-task-${taskId}"]`, {
      timeoutMs: modelResponseTimeoutMs,
    })
    await control.command('click', `[data-testid="stand-in-activity-task-${taskId}"]`)
    await control.command('waitFor', `${LIST} [data-testid="stand-in-work-open-pending"]`, {
      timeoutMs: modelResponseTimeoutMs,
    })
    assert.equal(Number(await control.command('getElementCount', `${LIST} ${CARD}`)), 0)
  }
  return {
    requiresCloudEnvironment: true,
    setCloudEnvironment(value) {
      cloud = value
    },
    diagnostics() {
      return { failedShellRequest }
    },
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (isReplyPredictionRequest(body)) return false
      const input = JSON.stringify(body.input ?? [])
      if (!input.includes(PROMPT)) return false
      const id = `list-approval-${Date.now()}`
      let events
      if (requestContainsToolOutput(body, 'stand-in-file-write')) {
        events = [
          assistantMessage(
            input.includes('DECLINE_EXPECTED')
              ? '已取消，本次操作未执行。'
              : '已按你的单次确认完成操作。'
          ),
        ]
      } else {
        try {
          const command = `touch '${file.replaceAll("'", "'\\''")}'`
          const approval = {
            sandbox_permissions: 'require_escalated',
            justification: '确认后创建隔离测试工作区中的验证文件。',
          }
          events = shellCommandResponse(
            body,
            'stand-in-file-write',
            command,
            workspacePath,
            approval
          )
        } catch (error) {
          failedShellRequest = shellCommandRequestDiagnostic(body)
          throw error
        }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await control.command('waitFor', ROOT)
      // Local file approvals must belong to the active account on the local device.
      const user = await fetchJson(`${cloud.backendUrl}/api/users/me`, {
        headers: { Authorization: `Bearer ${cloud.authToken}` },
      })
      userId = user.id
      const local = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
      await finishStandInOnboarding(control)
      await stopBoundStandIn(control, uiTimeoutMs)
      await bindStoppedStandIn(control, userId, local.deviceId, uiTimeoutMs)
      await finishStandInOnboarding(control)
      const settings = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId },
        uiTimeoutMs
      )
      assert.equal(settings.executionDeviceId, local.deviceId)
      await requestExecutor(
        control,
        'runtime.stand_in.personal.save',
        {
          userId,
          settings: {
            ...settings,
            roles: [
              ...settings.roles,
              {
                id: ROLE,
                name: '操作确认验证',
                enabled: false,
                prompt: '',
                version: 0,
                executionDeviceId: local.deviceId,
                collaboration: {
                  enabled: false,
                  allProjects: false,
                  projects: [],
                  excludedProjects: [],
                  tags: [],
                },
              },
            ],
          },
        },
        uiTimeoutMs
      )
      await reloadMainWindow(control)
      const taskId = 'stand-in-list-approve'
      const roleId = await createWork(control, taskId)
      await openList(control, roleId, taskId)
      await assert.rejects(access(file), { code: 'ENOENT' })
      await captureScreenshot(control, '01-list-awaiting-confirmation.png', LIST)
      await control.command('click', '[data-testid="stand-in-work-open-pending"]')
      await control.command('waitFor', '[data-testid="runtime-interactions-page"]')
      await control.command('waitFor', '[data-testid="interaction-open-original"]')
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="interaction-answer-0"]')),
        0
      )
      await assert.rejects(access(file), { code: 'ENOENT' })
      const summary = '[data-testid="interaction-list-summary"]'
      const summaryHeight = parseFloat(
        await control.command('getComputedStyleValue', summary, { value: 'height' })
      )
      const summaryLineHeight = parseFloat(
        await control.command('getComputedStyleValue', summary, { value: 'line-height' })
      )
      assert.ok(
        summaryHeight <= summaryLineHeight * 2 + 1,
        'Approval list summary must stay within two lines'
      )
      await captureScreenshot(control, '02-pending-links-to-native-approval.png')
      await control.command('click', '[data-testid="interaction-open-original"]')
      await waitForSnapshot(
        control,
        snapshot => new URL(snapshot.location).searchParams.get('taskId') === taskId,
        'Opening the original approval must navigate to its exact task',
        uiTimeoutMs
      )
      await control.command('waitFor', CARD, { timeoutMs: modelResponseTimeoutMs })
      const destination = new URL(JSON.parse(await control.command('snapshot', 'body')).location)
      assert.equal(destination.searchParams.get('taskId'), taskId)
      await assert.rejects(access(file), { code: 'ENOENT' })
      await control.command('click', '[data-testid="request-user-input-option-__codex_approval-0"]')
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: '已按你的单次确认完成操作',
        timeoutMs: modelResponseTimeoutMs,
      })
      await access(file)
      assert.equal(Number(await control.command('getElementCount', CARD, { visible: true })), 0)
      await captureScreenshot(control, '03-native-approved-operation-completed.png')
      await unlink(file)
      const declinedTask = 'stand-in-composer-decline'
      await createWork(control, declinedTask)
      await openList(control, roleId, declinedTask)
      await control.command('click', '[data-testid="stand-in-preview-open"]')
      await control.command('waitFor', CARD, { timeoutMs: modelResponseTimeoutMs })
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="chat-message-input"]')),
        0
      )
      await captureScreenshot(control, '04-conversation-input-confirmation.png')
      await control.command('click', '[data-testid="request-user-input-option-__codex_approval-1"]')
      await control.command('waitFor', '[data-testid="chat-message-input"]', {
        timeoutMs: modelResponseTimeoutMs,
      })
      await assert.rejects(access(file), { code: 'ENOENT' })
      await captureScreenshot(control, '05-declined-without-chat-answer.png')
    },
  }
}
