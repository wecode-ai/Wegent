import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  createSingleRootLocalProject,
  DEFAULT_MODEL_ID,
  runChecked,
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
import { reloadMainWindow, waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import { verifyHumanInteractionOverBrowser } from '../modules/human-interaction-browser.mjs'
import { verifyHumanInteractionAcrossWindows } from '../modules/human-interaction-windows.mjs'
import {
  handleArchiveInteractionModel,
  verifyInteractionArchiving,
} from '../modules/human-interaction-dismiss.mjs'
import {
  handleDismissAllModel,
  verifyDismissAll,
} from '../modules/human-interaction-dismiss-all.mjs'
import { verifyPendingInteractionsTab } from '../modules/pending-interactions-tab.mjs'
import { writeIssueInteractionIdentities } from '../modules/human-interaction-identity-diagnostics.mjs'
import { verifyInteractionTime } from '../modules/human-interaction-time.mjs'
import {
  handleArchivedTaskInteractionModel,
  verifyArchivedTaskInteractionCleanup,
} from '../modules/human-interaction-archived-task.mjs'
import { verifyPendingAnswerComposition } from '../modules/human-interaction-composition.mjs'
import { createPersistentInteractionNoticeCase } from '../modules/human-interaction-persistent-notice.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { readProjectChatMessages } from '../modules/project-chat-snapshot.mjs'
import { waitForElementInsideScroller, waitForSnapshot } from '../modules/conversation-layout.mjs'
import {
  assignHumanInteractionIssueToResponsible,
  startHumanInteractionIssue,
  verifyHumanInteractionIssueAccepted,
  verifyHumanInteractionIssueReply,
} from '../modules/human-interaction-issue.mjs'

const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const ORIGINAL = `${ACTIVE} [data-testid="desktop-workbench-surface"][aria-hidden="false"]`
const COMPOSER = `${ACTIVE} [data-active-workbench-pane="true"] [data-testid="chat-message-input"][contenteditable="true"]`
const PROMPT = 'HUMAN_INTERACTIONS_REVIEW'
const QUESTION = '旧客户是否继续保留原来的订单校验规则？'
const ANSWER = '保留旧规则，新客户使用新规则。'
const COMPLETION = '已收到你的判断，继续完成 review。'
const FOLLOWUP = `${PROMPT}_FOLLOWUP：继续检查兼容性实现，保持刚才确认的策略。`
const FOLLOWUP_COMPLETION = '原任务的后续会话已继续。'
const HIDDEN_TASK_TITLE = '隐藏执行的订单规则 Review'
const CONTEXT =
  '已检查现有订单校验实现：旧规则保留客户自定义阈值，新规则改用统一阈值。直接切换会改变存量客户的校验结果。当前尚未修改代码，需要先明确兼容性要求。'

export function createDesktopScenario({
  checkpoint,
  executorHome,
  workspacePath,
  captureScreenshot,
  resultDir,
  modelResponseTimeoutMs,
  uiTimeoutMs,
}) {
  let held
  const persistentNotice = createPersistentInteractionNoticeCase()
  let cloud
  let environment
  let issueFixture
  let issueDiagnostics
  let focusDiagnostics
  let contextItemId
  let originalTaskId
  let originalWorkspacePath
  let toolRequested = false
  const callId = 'human-interactions-business-question'
  const responseId = 'human-interactions-review'
  const releaseQuestion = () => {
    const context = assistantMessage(CONTEXT)
    contextItemId = context.item.id
    held.response.end(
      createSse([
        responseCreated(responseId),
        context,
        ...selectedToolCall(callId, held.tool, 1),
        responseCompleted(responseId),
      ])
    )
  }
  return {
    requiresCloudEnvironment: true,
    diagnostics() {
      return { checkpoint, issueDiagnostics, focusDiagnostics }
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
      if (handleArchivedTaskInteractionModel(body, response)) return true
      if (persistentNotice.handleModel(body, response)) return true
      if (handleDismissAllModel(body, response)) return true
      if (handleArchiveInteractionModel(body, response)) return true
      if (JSON.stringify(body.input).includes(FOLLOWUP)) {
        response.end(
          createSse([
            responseCreated(responseId),
            assistantMessage(FOLLOWUP_COMPLETION),
            responseCompleted(responseId),
          ])
        )
        return true
      }
      const output = toolOutputText(body, callId)
      if (output !== null) {
        assert.deepEqual(JSON.parse(output), { accepted: true })
        const answered = JSON.stringify(body.input).includes(ANSWER)
        response.end(
          createSse([
            responseCreated(responseId),
            assistantMessage(
              answered ? COMPLETION : `${CONTEXT}\n\n已有实现可以继续检查；兼容性策略等待你的判断。`
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
    async prepareApp() {
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
    },
    async verify(control) {
      await verifyPendingInteractionsTab(control, 0, { openFromMenu: true })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
      await createSingleRootLocalProject(control, workspacePath, 'human-interactions')
      await selectE2EModel(control)
      if (checkpoint === 'human-interactions-issue') {
        issueFixture = await startHumanInteractionIssue({
          cloud,
          environment,
          control,
          prompt: PROMPT,
          timeoutMs: modelResponseTimeoutMs,
          workspacePath,
        })
      } else if (checkpoint === 'human-interactions-hidden') {
        const hiddenPath = join(dirname(workspacePath), 'unlisted-question-workspace')
        originalWorkspacePath = hiddenPath
        // Keep the unlisted workspace independent of the enclosing CI checkout.
        await runChecked('git', ['clone', '--no-hardlinks', workspacePath, hiddenPath])
        const catalog = await requestExecutor(control, 'runtime.runner.catalog', {}, uiTimeoutMs)
        const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
        assert.ok(model)
        await requestExecutor(
          control,
          'runtime.tasks.create',
          {
            taskId: 'unlisted-review',
            title: HIDDEN_TASK_TITLE,
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
      if (!issueFixture) {
        if (checkpoint === 'human-interactions-hidden') originalTaskId = 'unlisted-review'
        else {
          const snapshot = await waitForSnapshot(
            control,
            value => {
              const url = new URL(value.location)
              return url.pathname.endsWith('/runtime-tasks') && url.searchParams.has('taskId')
            },
            'The source conversation must identify its task before opening the inbox',
            uiTimeoutMs
          )
          originalTaskId = new URL(snapshot.location).searchParams.get('taskId')
        }
      }
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
          releaseQuestion,
        })
        return
      }
      if (issueFixture) {
        // This scenario verifies in-app reminders; collaboration defaults to system delivery.
        await control.command('click', '[data-testid="wework-notifications-button"]')
        await control.command('click', '[data-testid="wework-notifications-settings"]')
        const systemSwitch = '[data-testid="wework-notifications-setting-collaboration-system"]'
        await control.command('waitFor', `${systemSwitch}[aria-checked="true"]`)
        await control.command('click', systemSwitch)
        await control.command('waitFor', `${systemSwitch}[aria-checked="false"]`)
        await control.command(
          'waitFor',
          '[data-testid="wework-notifications-setting-collaboration-in_app"][aria-checked="true"]'
        )
        await control.command('click', '[data-testid="wework-notifications-button"]')
      }
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await captureScreenshot(control, '01-working-in-another-tab.png')
      await control.command('focusMainWindow', 'body')
      const focus = JSON.parse(await control.command('getWindowFocusSnapshot', 'body'))
      assert.equal(focus.mainFocused, true, 'In-app reminders require real main-window focus')
      focusDiagnostics = { beforeQuestion: focus }
      releaseQuestion()
      // macOS background runs do not focus the native window through renderer clicks.
      // Wait for the real request before focusing, so model latency cannot lose the prerequisite.
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('waitFor', '[data-testid="wework-notifications-pending"]', {
        text: QUESTION,
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('focusMainWindow', 'body')
      try {
        await control.command('waitFor', '[data-testid="runtime-interaction-notice"]', {
          text: QUESTION,
          timeoutMs: modelResponseTimeoutMs,
        })
      } catch (error) {
        focusDiagnostics = {
          ...focusDiagnostics,
          afterFailure: JSON.parse(await control.command('getWindowFocusSnapshot', 'body')),
        }
        throw error
      }
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
      focusDiagnostics.afterReminderCapture = JSON.parse(
        await control.command('getWindowFocusSnapshot', 'body')
      )
      // Native focus can change during capture; in-app reminders require the foreground window.
      await control.command('focusMainWindow', 'body')
      await control.command('waitFor', '[data-testid="runtime-interaction-notice"]', {
        text: QUESTION,
        visible: true,
      })
      await control.command('hover', '[data-testid="runtime-interaction-notice"]')
      if (issueFixture) {
        await assignHumanInteractionIssueToResponsible(issueFixture, control, QUESTION, uiTimeoutMs)
      }
      await control.command('click', '[data-testid="interaction-notice-reply"]')
      try {
        await control.command(
          'waitFor',
          '[data-testid="runtime-interaction-notice"] [data-testid="interaction-reply-input"]',
          { visible: true }
        )
      } finally {
        focusDiagnostics.afterReplyClick = JSON.parse(
          await control.command('getWindowFocusSnapshot', 'body')
        )
      }
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
      const input = issueFixture
        ? `${page} [data-testid="cloud-task-activity-composer"]`
        : `${page} [data-testid="request-user-input-custom-question_1"]`
      const submit = issueFixture
        ? `${page} [data-testid="task-comment-form"] [data-testid="send-message-button"]`
        : `${page} [data-testid="request-user-input-submit-button"]`
      await control.command('waitFor', page, { text: QUESTION })
      await control.command(
        'waitFor',
        `${page} [data-testid="interaction-source-group-${issueFixture ? 'project' : 'task'}"]`,
        { text: QUESTION }
      )
      if (issueFixture) {
        await control.command(
          'waitFor',
          '[data-testid="workspace-tab-select-pending-interactions"][data-project-count-state="known"]'
        )
      }
      await verifyPendingInteractionsTab(control, 1, {
        openFromMenu: true,
        expectedProjectCount: 0,
      })
      const questionTime = await verifyInteractionTime(control, page)
      await control.command('waitFor', page, { text: CONTEXT })
      if (issueFixture) {
        const execution = issueDiagnostics.find(
          message => message.senderType === 'agent' && message.runtimeAddress
        )
        assert.ok(execution, 'The notification must identify its original execution')
        await control.command('waitFor', `${page} [data-message-id="${execution.id}"]`, {
          text: CONTEXT,
          visible: true,
        })
      }
      const contextParagraph = issueFixture
        ? `${page} [data-testid="task-activity-content-${issueDiagnostics.find(message => message.senderType === 'agent' && message.runtimeAddress).id}"] .task-activity-content-body p:first-of-type`
        : `${page} [data-testid="assistant-message-content"][data-runtime-item-id="${contextItemId}"] p:first-of-type`
      const readingViewport = `${page} [data-testid="${issueFixture ? 'cloud-todo-detail-scroll' : 'right-workspace-chat-scroll-area'}"]`
      const readingOptions = {
        clipToViewport: true,
        ...(issueFixture ? { occluderSelector: `${page} .task-detail-comment-bar` } : {}),
      }
      await control.command('waitFor', contextParagraph, { text: CONTEXT, visible: true })
      assert.equal(
        Number(await control.command('getElementCount', contextParagraph)),
        1,
        'The context fixture must identify exactly one original paragraph'
      )
      assert.ok(
        (await control.command('getText', contextParagraph)).includes(CONTEXT),
        'The measured paragraph must contain the original context'
      )
      const { element: contextBounds, scroller: readingBounds } =
        await waitForElementInsideScroller(
          control,
          contextParagraph,
          readingViewport,
          'Opening the pending entity must bring its original context paragraph into the reading viewport',
          uiTimeoutMs,
          readingOptions
        )
      assert.ok(
        contextBounds.height > 0 &&
          contextBounds.left >= readingBounds.left - 1 &&
          contextBounds.right <= readingBounds.right + 1,
        'The original context paragraph must be readable without horizontal clipping'
      )
      focusDiagnostics.initialContext = { contextBounds, readingBounds }
      await writeFile(
        join(resultDir, 'initial-context-metrics.json'),
        JSON.stringify(focusDiagnostics.initialContext, null, 2)
      )
      assert.equal(await control.command('getValue', input), ANSWER)
      if (!issueFixture) await verifyPendingAnswerComposition(control, input, ANSWER)
      assert.equal(
        Number(
          await control.command('getElementCount', `${ACTIVE} [data-testid="desktop-sidebar"]`)
        ),
        0
      )
      await captureScreenshot(control, '05-pending-tab-with-shared-draft.png')
      focusDiagnostics.entityMetrics = {}
      for (const id of [
        'interaction-entity-container',
        'work-item-context-panel',
        'cloud-todo-detail',
        'cloud-todo-detail-scroll',
      ]) {
        focusDiagnostics.entityMetrics[id] = JSON.parse(
          await control.command('getElementMetrics', `${page} [data-testid="${id}"]`)
        )
      }
      if (issueFixture) {
        for (const selector of [
          '[data-testid="work-item-context-panel"] > div',
          '.task-detail-workspace-panel-shell',
        ]) {
          focusDiagnostics.entityMetrics[selector] = JSON.parse(
            await control.command('getElementMetrics', `${page} ${selector}`)
          )
        }
      }
      if (issueFixture) {
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              `${page} [data-testid="cloud-todo-cancel-content-edit"]`
            )
          ),
          0,
          'Opening an Issue must use its original reading state'
        )
        const container = focusDiagnostics.entityMetrics['interaction-entity-container'][0]
        const detail = focusDiagnostics.entityMetrics['cloud-todo-detail'][0]
        assert.equal(
          focusDiagnostics.entityMetrics['.task-detail-workspace-panel-shell'][0].scrollTop,
          0,
          'Comment focus must scroll the content rather than the Issue frame'
        )
        assert.ok(
          detail.top >= container.top - 1,
          'The original Issue header must stay inside its entity pane'
        )
      }
      const [originalAction] = JSON.parse(
        await control.command(
          'getElementMetrics',
          `${page} [data-testid="interaction-open-original"]`
        )
      )
      assert.ok(
        originalAction.top >= 0,
        'The entity must scroll inside its pane without hiding the inbox header'
      )
      if (issueFixture) {
        const execution = issueDiagnostics.find(
          message => message.senderType === 'agent' && message.runtimeAddress
        )
        assert.ok(execution, 'The Issue must contain its original AI message')
        const originalMessage = `${page} [data-message-id="${execution.id}"]`
        await control.command('waitFor', originalMessage, { text: CONTEXT, visible: true })
        const [detail] = JSON.parse(
          await control.command('getElementMetrics', `${page} [data-testid="cloud-todo-detail"]`)
        )
        assert.ok(
          detail.top >= focusDiagnostics.entityMetrics['interaction-entity-container'][0].top - 1,
          'Reading original context must not scroll the Issue header out of its container'
        )
        await captureScreenshot(control, '05d-issue-original-context.png')
      }
      await writeFile(
        join(resultDir, 'entity-layout-metrics.json'),
        JSON.stringify(focusDiagnostics.entityMetrics, null, 2)
      )
      const previousSize = JSON.parse(
        await control.command('setMainWindowSize', 'body', {
          value: JSON.stringify({ width: 900, height: 700 }),
        })
      )
      try {
        focusDiagnostics.mediumContext = await waitForElementInsideScroller(
          control,
          contextParagraph,
          readingViewport,
          'The original context must remain readable after resizing to 900px',
          uiTimeoutMs,
          readingOptions
        )
        await writeFile(
          join(resultDir, 'medium-context-metrics.json'),
          JSON.stringify(focusDiagnostics.mediumContext, null, 2)
        )
        await captureScreenshot(control, '05a-entity-medium.png')
        await control.command('setMainWindowSize', 'body', {
          value: JSON.stringify({ width: 480, height: 760 }),
        })
        await control.command('waitFor', `${page} [data-testid="interactions-back-to-list"]`, {
          visible: true,
        })
        await verifyInteractionTime(control, page, { visible: 'detail', expected: questionTime })
        focusDiagnostics.narrowContext = await waitForElementInsideScroller(
          control,
          contextParagraph,
          readingViewport,
          'The original context must remain readable above the composer after resizing to 480px',
          uiTimeoutMs,
          readingOptions
        )
        await writeFile(
          join(resultDir, 'narrow-context-metrics.json'),
          JSON.stringify(focusDiagnostics.narrowContext, null, 2)
        )
        const [entity] = JSON.parse(
          await control.command(
            'getElementMetrics',
            `${page} [data-testid="interaction-entity-container"]`
          )
        )
        const questionRegion = `${page} [data-testid="interaction-question-heading"]`
        assert.ok(
          (await control.command('getText', questionRegion)).includes(QUESTION),
          'The measured original question region must contain the pending question'
        )
        const narrowElements = {}
        for (const [name, selector] of Object.entries({ questionRegion, input, submit })) {
          narrowElements[name] = JSON.parse(await control.command('getElementMetrics', selector))
        }
        focusDiagnostics.narrowLayout = {
          viewport: {
            width: entity.viewportWidth,
            height: entity.viewportHeight,
            devicePixelRatio: entity.devicePixelRatio,
          },
          entity,
          questionRegionKind: 'original-notification-question',
          ...narrowElements,
        }
        await writeFile(
          join(resultDir, 'narrow-layout-metrics.json'),
          JSON.stringify(focusDiagnostics.narrowLayout, null, 2)
        )
        assert.ok(
          entity.scrollWidth <= entity.clientWidth + 1,
          'The original entity must fit its narrow container'
        )
        await captureScreenshot(control, '05b-entity-narrow.png')
        assert.equal(entity.viewportWidth, 480, 'The actual narrow content width must be 480')
        assert.equal(entity.viewportHeight, 760, 'The actual narrow content height must be 760')
        assert.equal(
          narrowElements.questionRegion.length,
          1,
          'The selected question must have one detail heading'
        )
        const [questionBounds] = narrowElements.questionRegion
        assert.ok(
          questionBounds.width > 0 &&
            questionBounds.height > 0 &&
            questionBounds.left >= 0 &&
            questionBounds.top >= 0 &&
            questionBounds.right <= entity.viewportWidth &&
            questionBounds.bottom <= entity.viewportHeight &&
            questionBounds.scrollWidth <= questionBounds.clientWidth + 1,
          'The original question must be readable inside the narrow detail viewport'
        )
        assert.equal(narrowElements.submit.length, 1, 'The pending entity must have one submit')
        const [submitBounds] = narrowElements.submit
        assert.ok(
          submitBounds.width > 0 &&
            submitBounds.height > 0 &&
            submitBounds.left >= 0 &&
            submitBounds.top >= 0 &&
            submitBounds.right <= entity.viewportWidth &&
            submitBounds.bottom <= entity.viewportHeight,
          'The narrow submit button must fit completely inside the actual content viewport'
        )
        await control.command('click', `${page} [data-testid="interactions-back-to-list"]`)
        await control.command('waitFor', `${page} [data-testid="interaction-list-item"]`, {
          text: QUESTION,
          visible: true,
        })
        await captureScreenshot(control, '05c-narrow-inbox-list.png')
        await verifyInteractionTime(control, page, { visible: 'list', expected: questionTime })
        await control.command('click', `${page} [data-testid="interaction-list-item"]`)
        assert.equal(await control.command('getValue', input), ANSWER)
      } finally {
        await control.command('setMainWindowSize', 'body', { value: JSON.stringify(previousSize) })
      }
      await reloadMainWindow(control, 'The pending inbox did not reconnect after reload')
      await control.command('waitFor', page, { text: QUESTION, timeoutMs: modelResponseTimeoutMs })
      await verifyPendingInteractionsTab(control, 1, { expectedProjectCount: 0 })
      await verifyInteractionTime(control, page, { expected: questionTime })
      await control.command('waitFor', `${submit}:not(:disabled)`, { visible: true })
      assert.equal(await control.command('getValue', input), ANSWER)
      await captureScreenshot(control, '06-draft-survives-reload.png')
      if (issueFixture) {
        const execution = issueDiagnostics.find(
          message => message.senderType === 'agent' && message.runtimeAddress
        )
        assert.ok(execution, 'The Issue must expose its actual execution address')
        const executionAction = `${page} [data-testid="cloud-task-activity-execution-badge-${execution.id}"]`
        await control.command('waitFor', `${executionAction}:not(:disabled)`)
        await control.command('scrollIntoView', executionAction)
        await control.command('waitFor', `${executionAction}:not(:disabled)`, { visible: true })
        await control.command('click', executionAction)
        await waitForSnapshot(
          control,
          value => {
            const url = new URL(value.location)
            return (
              url.pathname.endsWith('/runtime-tasks') &&
              url.searchParams.get('taskId') === execution.runtimeAddress.taskId
            )
          },
          'The execution action must navigate to its original task',
          uiTimeoutMs
        )
        await control.command('waitFor', `${ORIGINAL} [data-testid="message-assistant"]`, {
          text: CONTEXT,
          visible: true,
          timeoutMs: modelResponseTimeoutMs,
        })
        const destination = new URL(JSON.parse(await control.command('snapshot', 'body')).location)
        assert.equal(destination.searchParams.get('taskId'), execution.runtimeAddress.taskId)
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              '[data-testid="runtime-execution-detail-overlay"]'
            )
          ),
          0,
          'Embedded execution actions must leave the container for the original task page'
        )
        await captureScreenshot(control, '06a-original-execution-workspace.png')
        await control.command('click', '[data-testid="wework-notifications-button"]')
        await control.command('waitFor', '[data-testid="wework-notifications-pending"]', {
          text: QUESTION,
        })
        await control.command('click', '[data-testid="wework-notifications-pending"]')
        await control.command('waitFor', `${submit}:not(:disabled)`, { visible: true })
        assert.equal(await control.command('getValue', input), ANSWER)
        await captureScreenshot(control, '06b-return-to-container-with-draft.png')
      }
      if (checkpoint === 'human-interactions') {
        await verifyHumanInteractionAcrossWindows({
          control,
          page,
          question: QUESTION,
          answer: ANSWER,
          captureScreenshot,
        })
      } else {
        await control.command('click', submit)
      }
      if (issueFixture) {
        const canonical = await verifyHumanInteractionIssueAccepted(
          issueFixture,
          callId,
          ANSWER,
          modelResponseTimeoutMs
        )
        await writeIssueInteractionIdentities({
          control,
          canonical,
          page,
          resultDir,
          timeoutMs: uiTimeoutMs,
        })
      }
      await control.command(
        'waitFor',
        '[data-testid="workspace-tab-select-pending-interactions"][data-pending-question-count="0"]',
        { timeoutMs: modelResponseTimeoutMs }
      )
      await verifyPendingInteractionsTab(control, 0, { expectedProjectCount: issueFixture ? 1 : 0 })
      await control.command('waitFor', `${page} [data-testid="interactions-pending-count"]`, {
        text: issueFixture ? '1' : '0',
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.equal(
        await control.command('getText', `${page} [data-testid="interactions-pending-count"]`),
        issueFixture ? '1' : '0'
      )
      if (issueFixture) {
        const ordinary = `${page} [data-testid="interaction-list-item"][data-project-issue="true"]`
        await control.command('waitFor', ordinary, { visible: true })
        assert.equal(Number(await control.command('getElementCount', ordinary)), 1)
        await control.command(
          'waitFor',
          '[data-testid="workspace-tab-select-pending-interactions"][data-project-count-state="known"][data-project-pending-count="1"]'
        )
        assert.equal(
          await control.command('getAttribute', ordinary, { value: 'data-interaction-id' }),
          `project-issue:backend:${issueFixture.projectId}:${issueFixture.issueId}`
        )
        assert.equal(
          await control.command(
            'getAttribute',
            '[data-testid="workspace-tab-select-pending-interactions"]',
            { value: 'data-project-pending-count' }
          ),
          '1'
        )
      } else {
        await control.command('waitFor', `${page} [data-testid="interactions-empty"]`, {
          visible: true,
          timeoutMs: modelResponseTimeoutMs,
        })
      }
      await captureScreenshot(control, '07-accepted-response-clears-pending.png')
      await verifyPendingInteractionsTab(control, 0, { expectedProjectCount: issueFixture ? 1 : 0 })
      await control.command('click', `${page} [data-testid="interactions-history"]`)
      await control.command('waitFor', `${page} [data-testid="interactions-history-count"]`, {
        visible: true,
      })
      await control.command('waitFor', page, { text: QUESTION })
      const handledTime = await verifyInteractionTime(control, page)
      assert.ok(Date.parse(handledTime) >= Date.parse(questionTime))
      await control.command('waitFor', contextParagraph, {
        text: CONTEXT,
        visible: true,
        timeoutMs: modelResponseTimeoutMs,
      })
      const historyReading = await waitForElementInsideScroller(
        control,
        contextParagraph,
        readingViewport,
        'Handled history must finish loading with its original context readable',
        uiTimeoutMs,
        readingOptions
      )
      await writeFile(
        join(resultDir, 'history-context-metrics.json'),
        JSON.stringify(historyReading, null, 2)
      )
      await captureScreenshot(control, '08-handled-history.png')
      if (issueFixture) {
        await verifyHumanInteractionIssueReply(issueFixture, ANSWER, modelResponseTimeoutMs)
        await control.command('click', `${page} [data-testid="interaction-open-original"]`)
        await waitForSnapshot(
          control,
          value => {
            const url = new URL(value.location)
            return (
              url.pathname.endsWith('/todo') &&
              url.searchParams.get('projectId') === issueFixture.projectId &&
              url.searchParams.get('itemId') === issueFixture.issueId
            )
          },
          'The container must navigate to its original Issue',
          uiTimeoutMs
        )
        const originalContext = contextParagraph.replace(page, ORIGINAL)
        await control.command('waitFor', originalContext, {
          text: CONTEXT,
          visible: true,
          timeoutMs: modelResponseTimeoutMs,
        })
        const originalReading = await waitForElementInsideScroller(
          control,
          originalContext,
          `${ORIGINAL} [data-testid="cloud-todo-detail-scroll"]`,
          'The original Issue must finish opening with its context above the composer',
          uiTimeoutMs,
          {
            clipToViewport: true,
            occluderSelector: `${ORIGINAL} .task-detail-comment-bar`,
          }
        )
        await writeFile(
          join(resultDir, 'original-issue-context-metrics.json'),
          JSON.stringify(originalReading, null, 2)
        )
        await captureScreenshot(control, '09-original-issue-thread-resumes.png')
        // The comment deep link scrolls the original context into view first.
        // Verify the heading through a real scroll after checking that landing.
        const originalTitle = `${ORIGINAL} [data-testid="cloud-todo-detail-title"]`
        await control.command(
          'scrollToRatioAsUser',
          `${ORIGINAL} [data-testid="cloud-todo-detail-scroll"]`,
          { value: '0' }
        )
        await control.command('waitFor', originalTitle, {
          text: '判断旧客户订单兼容策略',
          visible: true,
          timeoutMs: modelResponseTimeoutMs,
        })
        await captureScreenshot(control, '09a-original-issue-title.png')
        return
      }
      await control.command('click', `${page} [data-testid="interaction-open-original"]`)
      await waitForSnapshot(
        control,
        value => {
          const url = new URL(value.location)
          return (
            url.pathname.endsWith('/runtime-tasks') &&
            url.searchParams.get('taskId') === originalTaskId
          )
        },
        'The container must navigate to its original task before reading the transcript',
        uiTimeoutMs
      )
      await control.command('waitFor', `${ORIGINAL} [data-testid="message-assistant"]`, {
        text: COMPLETION,
        visible: true,
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${ORIGINAL} [data-testid="request-user-input-card"]`,
            { visible: true }
          )
        ),
        0
      )
      if (checkpoint === 'human-interactions') {
        const destination = new URL(JSON.parse(await control.command('snapshot', 'body')).location)
        const taskId = destination.searchParams.get('taskId')
        assert.ok(taskId, 'The original conversation URL must identify its task')
        // Debug state is published separately from the visible transcript on a bounded interval.
        const snapshot = await waitForWorkbenchDebugState(
          control,
          value => value.workbench?.currentRuntimeTask?.taskId === taskId,
          'The original task must own the visible conversation'
        )
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
      if (checkpoint === 'human-interactions-hidden') {
        await control.command('waitFor', `${ORIGINAL} [data-testid="workbench-pane-task-title"]`, {
          text: HIDDEN_TASK_TITLE,
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
        const restored = await waitForWorkbenchDebugState(
          control,
          value =>
            value.workbench?.currentRuntimeTask?.taskId === originalTaskId &&
            value.workbench.currentRuntimeTask.workspacePath === originalWorkspacePath,
          'The unlisted original task must restore its actual workspace'
        )
        const listed = await requestExecutor(
          control,
          'runtime.tasks.list',
          { preferCached: true },
          uiTimeoutMs
        )
        assert.ok(
          !JSON.stringify(listed).includes(originalTaskId),
          'Opening the original task must preserve the sidebar inventory filter'
        )
        await control.command('fill', COMPOSER, { value: FOLLOWUP })
        const send = `${ORIGINAL} [data-testid="send-message-button"]:not(:disabled)`
        await control.command('waitFor', send, { visible: true, timeoutMs: uiTimeoutMs })
        await captureScreenshot(control, '09-original-task-resumes.png')
        await control.command('click', send)
        await control.command('waitFor', `${ORIGINAL} [data-testid="message-assistant"]`, {
          text: FOLLOWUP_COMPLETION,
          visible: true,
          timeoutMs: modelResponseTimeoutMs,
        })
        const transcript = await requestExecutor(
          control,
          'runtime.tasks.transcript',
          {
            taskId: originalTaskId,
            workspacePath: restored.workbench.currentRuntimeTask.workspacePath,
            includeFullContent: true,
            limit: 100,
          },
          uiTimeoutMs
        )
        assert.equal(
          transcript.messages.filter(
            message => message.role === 'user' && JSON.stringify(message).includes(FOLLOWUP)
          ).length,
          1,
          'The follow-up must persist exactly once in the original unlisted task'
        )
        await captureScreenshot(control, '10-original-task-followup.png')
      } else await captureScreenshot(control, '09-original-task-resumes.png')
      if (checkpoint === 'human-interactions') {
        await verifyInteractionArchiving(control, modelResponseTimeoutMs, originalTaskId)
        await verifyDismissAll(control, modelResponseTimeoutMs, originalTaskId)
        await control.command('click', `${page} [data-testid="interaction-open-original"]`)
        await persistentNotice.verify(control, modelResponseTimeoutMs)
        await verifyArchivedTaskInteractionCleanup(control, modelResponseTimeoutMs)
      }
    },
  }
}
