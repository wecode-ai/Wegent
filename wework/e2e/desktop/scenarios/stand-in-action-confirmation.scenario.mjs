import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  assistantMessage,
  createSse,
  functionCall,
  isReplyPredictionRequest,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectShellToolCommand,
} from '../modules/response-protocol.mjs'

const TASK = 'stand-in-confirmation-work'
const PROMPT = 'STAND_IN_VERIFY_EXPLICIT_WRITE_CONFIRMATION'
const DISPLAY_MESSAGE = '请在隔离工作区创建验证文件，执行前先让我确认。'
const ROOT = '[data-testid="stand-in-overview"]'

export function createDesktopScenario({
  captureScreenshot,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  workspacePath,
}) {
  const file = join(workspacePath, 'stand-in-approved.txt')
  let requested = false
  return {
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (isReplyPredictionRequest(body)) return false
      if (!JSON.stringify(body.input ?? []).includes(PROMPT)) return false
      const id = `stand-in-approval-${Date.now()}`
      let events
      if (requestContainsToolOutput(body, 'stand-in-file-write'))
        events = [assistantMessage('已按你的单次确认完成操作。')]
      else {
        const tool = selectShellToolCommand(
          body,
          `touch '${file.replaceAll("'", "'\\''")}'`,
          workspacePath
        )
        tool.arguments.sandbox_permissions = 'require_escalated'
        tool.arguments.justification = '确认后创建隔离测试工作区中的验证文件。'
        events = functionCall('stand-in-file-write', tool.name, tool.arguments)
        requested = true
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('click', '[data-testid="collaboration-primary-stand-in"]')
      await control.command('waitFor', ROOT)
      const settings = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: 9001 },
        uiTimeoutMs
      )
      const catalog = await requestExecutor(control, 'runtime.runner.catalog', {}, uiTimeoutMs)
      const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
      assert.ok(model)
      const origin = {
        type: 'stand_in_verification',
        initiatedBy: 'stand_in',
        userId: 9001,
        standInId: settings.roles[0].id,
        deviceId: settings.executionDeviceId,
        askBeforeAct: true,
      }
      await requestExecutor(
        control,
        'runtime.tasks.create',
        {
          taskId: TASK,
          title: '操作前确认验证',
          runtime: 'codex',
          workspacePath,
          message: DISPLAY_MESSAGE,
          clientUserMessageId: 'stand-in-confirmation-initial',
          restoreUserMessageContent: true,
          origin,
          executionRequest: {
            task_id: TASK,
            subtask_id: `${TASK}-initial`,
            user_id: 9001,
            prompt: PROMPT,
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
      await control.command(
        'click',
        `[data-testid="stand-in-overview-role-${settings.roles[0].id}"]`
      )
      await control.command('waitFor', `[data-testid="stand-in-activity-task-${TASK}"]`, {
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('click', `[data-testid="stand-in-activity-task-${TASK}"]`)
      await control.command('waitFor', '[data-testid="stand-in-work-preview"]')
      await captureScreenshot(control, '01-work-inline-preview.png', ROOT)
      await control.command('click', '[data-testid="stand-in-preview-open"]')
      await control.command('waitFor', '[data-testid="request-user-input-card"]', {
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="user-message-content"]', {
        text: DISPLAY_MESSAGE,
        timeoutMs: uiTimeoutMs,
      })
      const displayedMessage = await control.command(
        'getText',
        '[data-testid="user-message-content"]'
      )
      assert.ok(
        !displayedMessage.includes(PROMPT),
        'Internal execution instructions must stay hidden'
      )
      assert.equal(requested, true)
      await assert.rejects(access(file), { code: 'ENOENT' })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            '[data-testid^="request-user-input-option-__codex_approval-"]'
          )
        ),
        2
      )
      const approvalText = await control.command(
        'getText',
        '[data-testid="request-user-input-card"]'
      )
      assert.ok(!approvalText.includes('允许此命令规则') && !approvalText.includes('以后不再询问'))
      await captureScreenshot(control, '02-action-awaiting-confirmation.png')
      await control.command('click', '[data-testid="request-user-input-option-__codex_approval-0"]')
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: '已按你的单次确认完成操作',
        timeoutMs: modelResponseTimeoutMs,
      })
      await access(file)
      await captureScreenshot(control, '03-confirmed-operation-completed.png')
    },
    diagnostics() {
      return { requested }
    },
  }
}
