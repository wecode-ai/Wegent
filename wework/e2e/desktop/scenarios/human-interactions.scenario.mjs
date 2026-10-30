import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  createSingleRootLocalProject,
  DEFAULT_MODEL_ID,
  selectE2EModel,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  functionCall,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
  selectTool,
  toolOutputText,
} from '../modules/response-protocol.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import { verifyHumanInteractionOverBrowser } from '../modules/human-interaction-browser.mjs'
import { verifyHumanInteractionAcrossWindows } from '../modules/human-interaction-windows.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { readProjectChatMessages } from '../modules/project-chat-snapshot.mjs'
import {
  startHumanInteractionIssue,
  verifyHumanInteractionIssueReply,
} from '../modules/human-interaction-issue.mjs'

const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const COMPOSER = `${ACTIVE} [data-active-workbench-pane="true"] [data-testid="chat-message-input"][contenteditable="true"]`
const PROMPT = 'HUMAN_INTERACTIONS_REVIEW'
const QUESTION = '旧客户是否继续保留原来的订单校验规则？'
const ANSWER = '保留旧规则，新客户使用新规则。'
const COMPLETION = '已收到你的判断，继续完成 review。'

export function createDesktopScenario({
  checkpoint,
  executorHome,
  workspacePath,
  captureScreenshot,
  modelResponseTimeoutMs,
  uiTimeoutMs,
}) {
  let held
  let cloud
  let environment
  let issueFixture
  let issueDiagnostics
  let toolRequested = false
  const callId = 'human-interactions-business-question'
  const responseId = 'human-interactions-review'
  return {
    requiresCloudEnvironment: true,
    diagnostics() {
      return { checkpoint, issueDiagnostics }
    },
    async prepareCloud(value) {
      cloud = value
    },
    setCloudEnvironment(value) {
      environment = value
    },
    async handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === '/human-interactions-browser-fixture') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(
          '<!doctype html><html lang="zh-CN"><title>订单兼容性说明</title><body><h1>订单兼容性说明</h1><p>旧客户仍使用现有订单校验规则。新客户可采用新规则。</p></body></html>'
        )
        return true
      }
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(JSON.stringify(body).includes(PROMPT), 'Unexpected model request')
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      const output = toolOutputText(body, callId)
      if (output !== null) {
        assert.deepEqual(JSON.parse(output), { accepted: true })
        const answered = JSON.stringify(body.input).includes(ANSWER)
        response.end(
          createSse([
            responseCreated(responseId),
            assistantMessage(
              answered ? COMPLETION : '已有实现可以继续检查；兼容性策略等待你的判断。'
            ),
            responseCompleted(responseId),
          ])
        )
      } else {
        assert.equal(toolRequested, false, 'The same question was emitted twice')
        const tool = selectTool(body, 'request_user_input_async', {
          questions: [{ title: QUESTION }],
        })
        held = { response, tool }
        toolRequested = true
      }
      return true
    },
    async verify(control) {
      const capabilities = join(executorHome, 'capabilities')
      await mkdir(capabilities, { recursive: true })
      await writeFile(
        join(capabilities, 'model-catalog-overrides.json'),
        JSON.stringify([
          {
            slug: DEFAULT_MODEL_ID,
            fields: { experimental_supported_tools: ['request_user_input_async'] },
          },
        ])
      )
      await rm(join(executorHome, 'codex', 'models_cache.json'), { force: true })
      await createSingleRootLocalProject(control, workspacePath, 'human-interactions')
      await selectE2EModel(control)
      if (checkpoint === 'human-interactions-issue') {
        issueFixture = await startHumanInteractionIssue({
          cloud,
          environment,
          control,
          prompt: PROMPT,
          timeoutMs: modelResponseTimeoutMs,
        })
      } else if (checkpoint === 'human-interactions-hidden') {
        const hiddenPath = join(dirname(workspacePath), 'unlisted-question-workspace')
        await mkdir(hiddenPath, { recursive: true })
        const catalog = await requestExecutor(control, 'runtime.runner.catalog', {}, uiTimeoutMs)
        const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
        assert.ok(model)
        await requestExecutor(
          control,
          'runtime.tasks.create',
          {
            taskId: 'unlisted-review',
            title: '隐藏执行的订单规则 Review',
            runtime: 'codex',
            workspacePath: hiddenPath,
            message: 'Review 订单规则，遇到兼容性判断时交给我。',
            clientUserMessageId: 'unlisted-review-initial',
            restoreUserMessageContent: true,
            executionRequest: {
              task_id: 'unlisted-review',
              subtask_id: 'unlisted-review-initial',
              user_id: 9001,
              prompt: PROMPT,
              new_session: true,
              bot: [{ shell_type: 'Codex', name: 'Unlisted review' }],
              model_config: { model_id: model.local_model_id, model_provider: model.provider },
            },
            modelSelection: {
              modelName: model.local_model_id,
              modelType: 'runtime',
              options: { runnerModelProvider: model.provider },
            },
          },
          uiTimeoutMs
        )
        const listed = await requestExecutor(
          control,
          'runtime.tasks.list',
          { preferCached: true },
          uiTimeoutMs
        )
        assert.ok(
          !JSON.stringify(listed).includes('unlisted-review'),
          'The regression must start with a genuinely filtered execution'
        )
      } else {
        await control.command('fill', COMPOSER, {
          value: `${PROMPT}：review 订单规则，无法判断兼容策略时交给我。`,
        })
        await control.command(
          'waitFor',
          `${ACTIVE} [data-testid="send-message-button"]:not(:disabled)`
        )
        await control.command('press', COMPOSER, { key: 'Enter' })
      }
      const deadline = Date.now() + modelResponseTimeoutMs
      while (!held && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
      assert.ok(held, 'The real Codex run never requested the question tool')
      if (issueFixture) {
        const messages = await readProjectChatMessages(
          issueFixture,
          issueFixture.issueId,
          uiTimeoutMs
        )
        issueDiagnostics = messages.map(message => ({
          id: message.messageId,
          senderType: message.sender.type,
          rootId: message.rootMessageId,
          triggerId: message.triggerMessageId,
          runtimeAddress: message.runtimeAddress && {
            deviceId: message.runtimeAddress.deviceId,
            taskId: message.runtimeAddress.taskId,
          },
          status: message.status,
        }))
        console.log(
          '[human-interaction-issue] Owning comment addresses',
          JSON.stringify(issueDiagnostics)
        )
      }
      if (checkpoint === 'human-interactions-browser') {
        await verifyHumanInteractionOverBrowser({
          control,
          question: QUESTION,
          answer: ANSWER,
          captureScreenshot,
          uiTimeoutMs,
          modelResponseTimeoutMs,
          releaseQuestion: () =>
            held.response.end(
              createSse([
                responseCreated(responseId),
                ...functionCall(callId, held.tool.name, held.tool.arguments),
                responseCompleted(responseId),
              ])
            ),
        })
        return
      }
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await captureScreenshot(control, '01-working-in-another-tab.png')
      held.response.end(
        createSse([
          responseCreated(responseId),
          ...functionCall(callId, held.tool.name, held.tool.arguments),
          responseCompleted(responseId),
        ])
      )
      // macOS background runs do not focus the native window through renderer clicks.
      // Wait for the real request before focusing, so model latency cannot lose the prerequisite.
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('waitFor', '[data-testid="wework-notifications-pending"]', {
        text: QUESTION,
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('focusMainWindow', 'body')
      await control.command('waitFor', '[data-testid="runtime-interaction-notice"]', {
        text: QUESTION,
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            '[data-testid="sidebar-global-im-notification-button"]'
          )
        ),
        0
      )
      await captureScreenshot(control, '02-global-compact-reminder.png')
      await control.command('click', '[data-testid="interaction-notice-reply"]')
      await control.command(
        'fill',
        '[data-testid="runtime-interaction-notice"] [data-testid="interaction-reply-input"]',
        { value: ANSWER }
      )
      await captureScreenshot(control, '03-expanded-quick-reply-draft.png')
      await control.command('click', '[data-testid="interaction-notice-dismiss"]')
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('waitFor', '[data-testid="wework-notifications-pending"]', {
        text: QUESTION,
      })
      await captureScreenshot(control, '04-single-notification-entry.png')
      await control.command('click', '[data-testid="wework-notifications-pending"]')
      const page = `${ACTIVE} [data-testid="runtime-interactions-page"]`
      await control.command('waitFor', page, { text: QUESTION })
      assert.equal(
        await control.command('getValue', `${page} [data-testid="interaction-reply-input"]`),
        ANSWER
      )
      assert.equal(
        Number(
          await control.command('getElementCount', `${ACTIVE} [data-testid="desktop-sidebar"]`)
        ),
        0
      )
      await captureScreenshot(control, '05-pending-tab-with-shared-draft.png')
      await reloadMainWindow(control, 'The pending inbox did not reconnect after reload')
      await control.command('waitFor', page, { text: QUESTION, timeoutMs: modelResponseTimeoutMs })
      await control.command(
        'waitFor',
        `${page} [data-testid="interaction-reply-input"]:not(:disabled)`,
        { visible: true }
      )
      assert.equal(
        await control.command('getValue', `${page} [data-testid="interaction-reply-input"]`),
        ANSWER
      )
      await captureScreenshot(control, '06-draft-survives-reload.png')
      if (checkpoint === 'human-interactions') {
        await verifyHumanInteractionAcrossWindows({
          control,
          page,
          question: QUESTION,
          answer: ANSWER,
          captureScreenshot,
        })
      } else {
        await control.command('click', `${page} [data-testid="interaction-reply-send"]`)
      }
      await control.command('waitFor', `${page} [data-testid="interactions-pending-count"]`, {
        text: '0',
        timeoutMs: modelResponseTimeoutMs,
      })
      await captureScreenshot(control, '07-accepted-response-clears-pending.png')
      await control.command('click', `${page} [data-testid="interactions-history"]`)
      await control.command('waitFor', page, { text: QUESTION })
      await captureScreenshot(control, '08-handled-history.png')
      if (issueFixture) {
        await verifyHumanInteractionIssueReply(issueFixture, ANSWER, modelResponseTimeoutMs)
        await control.command('click', `${page} [data-testid="interaction-open-original"]`)
        await control.command('waitFor', `${ACTIVE} [data-testid="cloud-todo-detail-title"]`, {
          text: '判断旧客户订单兼容策略',
          timeoutMs: modelResponseTimeoutMs,
        })
        await captureScreenshot(control, '09-original-issue-thread-resumes.png')
        return
      }
      await control.command('click', `${page} [data-testid="interaction-open-original"]`)
      await control.command('waitFor', `${ACTIVE} [data-testid="message-assistant"]`, {
        text: COMPLETION,
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${ACTIVE} [data-testid="request-user-input-card"]`,
            { visible: true }
          )
        ),
        0
      )
      if (checkpoint === 'human-interactions') {
        const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        const address = snapshot.workbench?.currentRuntimeTask
        assert.ok(address?.taskId, 'The original task must own the visible conversation')
        const transcript = await requestExecutor(
          control,
          'runtime.tasks.transcript',
          {
            taskId: address.taskId,
            workspacePath: address.workspacePath,
            includeFullContent: true,
            limit: 100,
          },
          uiTimeoutMs
        )
        assert.equal(
          transcript.messages.filter(
            message => message.role === 'user' && JSON.stringify(message).includes(ANSWER)
          ).length,
          1,
          'Two windows must persist exactly one human answer in the original runtime'
        )
      }
      await captureScreenshot(control, '09-original-task-resumes.png')
    },
  }
}
