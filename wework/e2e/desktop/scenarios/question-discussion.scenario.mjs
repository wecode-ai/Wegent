import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  DEFAULT_MODEL_ID,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  functionCall,
  handleEmptyReplyPrediction,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectTool,
} from '../modules/response-protocol.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import { waitForElementWidth } from '../modules/layout-metrics.mjs'

const PROMPT = '请帮我整理本周项目进展，先确定周报的接收范围。'
const QUESTION = '项目周报应该发给谁？'
const FOLLOW_UP = '如果有敏感事项呢？请给出可以回填的结论。'
const ADVICE =
  '建议先发给项目成员。这样能覆盖协作需要，也能减少不必要的信息扩散。你更关心协作效率，还是敏感信息的保护？'
const CONCLUSION = '周报仅发送给项目成员，敏感事项只保留给项目负责人。'
const COMPLETE = '已确认接收范围，将按这个结论继续整理周报。'
const DIALOG = '[aria-hidden="false"] > [data-testid="question-discussion-dialog"]'
const SIDE = `${DIALOG} [data-testid="question-discussion-conversation"]`
const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const PAGE = `${ACTIVE} [data-testid="runtime-interactions-page"]`
const CARD = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-card"]`
const callId = 'question-discussion-audience'

export function createDesktopScenario({
  executorHome,
  workspacePath,
  resultDir,
  captureScreenshot,
  workbenchReadyTimeoutMs,
}) {
  let active = false
  let discussionCalls = 0
  let finalAnswers = 0
  let firstToolName
  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const text = JSON.stringify(body.input ?? body.messages ?? [])
      if (!text.includes(PROMPT) && !text.includes(QUESTION)) return false
      const id = `discussion-${Date.now()}`
      let events
      if (text.includes('Side conversation boundary.') || text.includes('我对下面的问题还拿不准')) {
        discussionCalls += 1
        events = [assistantMessage(text.includes(FOLLOW_UP) ? CONCLUSION : ADVICE)]
      } else if (!requestContainsToolOutput(body, callId)) {
        const tool = selectTool(body, 'request_user_input_async', {
          questions: [{ title: QUESTION, options: ['项目成员', '全公司'] }],
        })
        firstToolName = tool.name
        events = functionCall(callId, tool.name, tool.arguments)
      } else if (text.includes(CONCLUSION)) {
        finalAnswers += 1
        events = [assistantMessage(COMPLETE)]
      } else {
        events = [assistantMessage('接收范围还未确定，等待你的确认。')]
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      active = true
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
      await control.command('waitFor', '[data-testid="new-chat-button"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="new-chat-button"]')
      const workspace = join(workspacePath, 'question-discussion')
      await mkdir(workspace, { recursive: true })
      await createSingleRootLocalProject(control, workspace, '周报范围讨论')
      await selectE2EModel(control)
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      await control.command('waitFor', CARD, { text: QUESTION, visible: true })
      const original = await waitForWorkbenchDebugState(
        control,
        snapshot => snapshot.pane?.currentRuntimeTask?.taskId && !snapshot.pane.status.isBusy,
        'The original question must remain pending after its turn settles'
      )
      const source = original.pane.currentRuntimeTask
      await captureScreenshot(control, 'question-discussion-01-original-question.png', 'body')
      await control.command('click', `${CARD} [data-testid="request-user-input-discuss"]`)
      await control.command('waitFor', `${SIDE} [data-testid="message-assistant"]`, {
        text: ADVICE,
        visible: true,
      })
      assert.equal(finalAnswers, 0, 'Opening discussion cannot answer the original question')
      await captureScreenshot(control, 'question-discussion-02-discuss-options.png', 'body')
      const sideComposer = `${SIDE} [data-testid="chat-message-input"]`
      await control.command('fill', sideComposer, { value: FOLLOW_UP })
      await control.command('clickWhenEnabled', `${SIDE} [data-testid="send-message-button"]`)
      await control.command('waitFor', `${SIDE} [data-testid="message-assistant"]`, {
        text: CONCLUSION,
        visible: true,
      })
      await captureScreenshot(control, 'question-discussion-03-follow-up.png', 'body')
      await control.command(
        'clickWhenEnabled',
        `${DIALOG} [data-testid="question-discussion-use-reply"]`
      )
      assert.equal(
        await control.command(
          'getValue',
          `${DIALOG} [data-testid="question-discussion-conclusion"]`
        ),
        CONCLUSION
      )
      await control.command('click', `${DIALOG} [data-testid="question-discussion-close"]`)
      // Reach the actual pending-work page through its native tab entry.
      await control.command('click', '[data-testid="workspace-tab-add"]')
      await control.command('click', '[data-testid="workspace-tab-add-pending-interactions"]')
      await control.command('waitFor', `${PAGE} [data-testid="interaction-list-item"]`, {
        text: QUESTION,
        visible: true,
      })
      await control.command('click', `${PAGE} [data-testid="interaction-list-item"]`, {
        text: QUESTION,
      })
      await control.command('clickWhenEnabled', `${PAGE} [data-testid="interaction-discuss"]`)
      await control.command('waitFor', `${SIDE} [data-testid="message-assistant"]`, {
        text: CONCLUSION,
        visible: true,
      })
      assert.equal(discussionCalls, 2, 'Both entry points must reuse the same two-turn discussion')
      await captureScreenshot(control, 'question-discussion-04-pending-work-reopen.png', 'body')
      const previousSize = await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 480, height: 760 }),
      })
      const narrow = await waitForElementWidth(
        control,
        DIALOG,
        width => width <= 480,
        'narrow discussion'
      )
      assert.ok(
        narrow.scrollWidth <= narrow.clientWidth,
        'The discussion must not overflow horizontally'
      )
      const [applyButton] = JSON.parse(
        await control.command(
          'getElementMetrics',
          `${DIALOG} [data-testid="question-discussion-apply"]`
        )
      )
      assert.ok(
        applyButton.bottom <= applyButton.viewportHeight && applyButton.left >= 0,
        'The conclusion action must remain visible on a narrow screen'
      )
      const [composer] = JSON.parse(
        await control.command(
          'getElementMetrics',
          `${SIDE} [data-testid="right-workspace-chat-composer-shell"]`
        )
      )
      const [answerRegion] = JSON.parse(
        await control.command(
          'getElementMetrics',
          `${DIALOG} [data-testid="question-discussion-answer"]`
        )
      )
      assert.ok(
        composer.bottom <= answerRegion.top + 1,
        'The discussion composer must not cover the conclusion region'
      )
      await captureScreenshot(control, 'question-discussion-04a-narrow.png', 'body')
      await control.command('clickAt', 'body', {
        value: JSON.stringify({
          x: applyButton.left + applyButton.width / 2,
          y: applyButton.top + applyButton.height / 2,
        }),
      })
      await control.command(
        'waitFor',
        `${PAGE} [data-testid="request-user-input-custom-question_1"]`,
        { visible: true }
      )
      await captureScreenshot(control, 'question-discussion-04a2-narrow-answer.png', 'body')
      await control.command('setMainWindowSize', 'body', { value: previousSize })
      await control.command('clickWhenEnabled', `${PAGE} [data-testid="interaction-discuss"]`)
      await waitForElementWidth(control, DIALOG, width => width > 700, 'restored discussion')
      await control.command('click', `${DIALOG} [data-testid="question-discussion-close"]`)
      await control.command('navigate', 'body', { value: '/settings/appearance' })
      await control.command('clickWhenEnabled', '[data-testid="appearance-mode-dark"]')
      await control.command('waitFor', 'html[data-theme="dark"]')
      await control.command('navigate', 'body', { value: '/pending-interactions' })
      await control.command('clickWhenEnabled', `${PAGE} [data-testid="interaction-discuss"]`)
      await control.command('waitFor', `${SIDE} [data-testid="message-assistant"]`, {
        text: CONCLUSION,
        visible: true,
      })
      await captureScreenshot(control, 'question-discussion-04b-dark.png', 'body')
      await control.command(
        'clickWhenEnabled',
        `${DIALOG} [data-testid="question-discussion-apply"]`
      )
      const answer = `${PAGE} [data-testid="request-user-input-custom-question_1"]`
      await control.command('waitFor', answer, { visible: true })
      assert.equal(await control.command('getValue', answer), CONCLUSION)
      assert.equal(finalAnswers, 0, 'Filling a draft cannot submit it')
      await captureScreenshot(control, 'question-discussion-05-editable-answer.png', 'body')
      await control.command(
        'clickWhenEnabled',
        `${PAGE} [data-testid="request-user-input-submit-button"]`
      )
      await control.command('waitFor', `${PAGE} [data-testid="interactions-pending-count"]`, {
        text: '0',
      })
      await control.command('click', `${PAGE} [data-testid="interaction-open-original"]`)
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        { text: COMPLETE, visible: true }
      )
      assert.equal(finalAnswers, 1, 'The original task must receive exactly one confirmed answer')
      const final = await waitForWorkbenchDebugState(
        control,
        snapshot =>
          snapshot.pane?.currentRuntimeTask?.taskId === source.taskId &&
          !snapshot.pane.status.isBusy,
        'The original task must continue after receiving the answer'
      )
      assert.equal(final.pane.currentRuntimeTask.taskId, source.taskId)
      assert.ok(firstToolName, 'The question must originate from the real model tool protocol')
      await captureScreenshot(control, 'question-discussion-06-original-resumed.png', 'body')
      await writeFile(
        join(resultDir, 'question-discussion-user-story.json'),
        JSON.stringify({ source, discussionCalls, finalAnswers, result: 'passed' }, null, 2)
      )
      active = false
    },
  }
}
