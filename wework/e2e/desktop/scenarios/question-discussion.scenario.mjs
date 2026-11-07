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
  selectedToolCall,
  handleEmptyReplyPrediction,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectTool,
} from '../modules/response-protocol.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import { waitForElementWidth } from '../modules/layout-metrics.mjs'
import {
  OTHER_TASK_PROMPT,
  OTHER_TASK_REPLY,
  verifyQuestionDiscussionTabs,
} from '../modules/question-discussion-tabs.mjs'

const PROMPT = '请帮我整理本周项目进展，先确定周报的接收范围。'
const MULTI_PROMPT = `${PROMPT} 还要确定发送时间。`
const LONG_QUESTION =
  '当项目周报包含尚未公开的产品计划、跨团队协作进展和需要负责人确认的风险事项时，应该在什么时间向不同接收范围发送以及如何确认发送前已经完成敏感信息检查？'
const QUESTION = '项目周报应该发给谁？'
const FOLLOW_UP = '如果有敏感事项呢？请给出可以回填的结论。'
const ADVICE =
  '建议先发给项目成员。这样能覆盖协作需要，也能减少不必要的信息扩散。你更关心协作效率，还是敏感信息的保护？'
const CONCLUSION = '周报仅发送给项目成员，敏感事项只保留给项目负责人。'
const COMPLETE = '已确认接收范围，将按这个结论继续整理周报。'
const SELECTED = '周报仅发送给项目成员'
const FILL_SELECTION = '[data-testid="fill-selection-to-answer-button"]'
const ORDINARY_MESSAGE = '先只整理，不发送周报。'
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
  let ordinaryAnswers = 0
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
      if (!text.includes(PROMPT) && !text.includes(QUESTION) && !text.includes(OTHER_TASK_PROMPT))
        return false
      const id = `discussion-${Date.now()}`
      let events
      if (text.includes(OTHER_TASK_PROMPT)) {
        events = [assistantMessage(OTHER_TASK_REPLY)]
      } else if (
        text.includes('Side conversation boundary.') ||
        text.includes('我对下面的问题还拿不准')
      ) {
        discussionCalls += 1
        events = [assistantMessage(text.includes(FOLLOW_UP) ? CONCLUSION : ADVICE)]
      } else if (text.includes(ORDINARY_MESSAGE)) {
        ordinaryAnswers += 1
        events = [assistantMessage(COMPLETE)]
      } else if (!requestContainsToolOutput(body, callId)) {
        const tool = selectTool(body, 'request_user_input_async', {
          questions: [
            { title: QUESTION, options: ['项目成员', '全公司'] },
            ...(text.includes(MULTI_PROMPT)
              ? [{ title: LONG_QUESTION, options: ['确认后发送', '定时发送'] }]
              : []),
          ],
        })
        firstToolName = tool.name
        events = selectedToolCall(callId, tool)
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
      const draftAnswer = `${CARD} [data-testid="request-user-input-custom-question_1"]`
      await control.command('fill', draftAnswer, { value: '只发给项目成员，先讨论敏感事项。' })
      await control.command('click', `${CARD} [data-testid="request-user-input-ignore-button"]`)
      const expandQuestion = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-expand"]`
      await control.command('waitFor', expandQuestion, { visible: true, text: QUESTION })
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, { visible: true })
      await captureScreenshot(control, 'question-discussion-01a-collapsed-question.png', 'body')
      await control.command('click', expandQuestion)
      assert.equal(
        await control.command('getValue', draftAnswer),
        '只发给项目成员，先讨论敏感事项。'
      )
      await control.command('press', draftAnswer, { key: 'Escape' })
      await control.command('waitFor', expandQuestion, { visible: true })
      await control.command('click', expandQuestion)
      assert.equal(
        await control.command('getValue', draftAnswer),
        '只发给项目成员，先讨论敏感事项。'
      )
      assert.equal(finalAnswers, 0, 'Folding and reopening cannot cancel or answer the question')
      await control.command('click', `${CARD} [data-testid="request-user-input-discuss"]`)
      const sideComposer = `${SIDE} [data-testid="chat-message-input"]`
      await control.command('waitFor', sideComposer, { visible: true })
      const prepared = await control.command('getValue', sideComposer)
      assert.ok(prepared.includes(QUESTION), 'Opening should prepare an editable question')
      assert.equal(discussionCalls, 0, 'Opening must not send a model request')
      await control.command(
        'waitFor',
        '[data-testid="toggle-right-workspace-panel-button"]:not(:disabled)',
        { visible: true }
      )
      await captureScreenshot(control, 'question-discussion-02a-unsent-prompt.png', 'body')
      const editedPrompt = `${QUESTION} 请先讨论项目成员方案。`
      await control.command('fill', sideComposer, { value: editedPrompt })
      await control.command('press', 'body', {
        key: process.platform === 'darwin' ? 'Meta+t' : 'Control+t',
      })
      await control.command('waitFor', DIALOG, { visible: false })
      await control.command('waitFor', '[data-testid="workspace-browser-url-input"]', {
        visible: true,
      })
      await captureScreenshot(control, 'question-discussion-02a2-browser-shortcut.png', 'body')
      assert.equal(discussionCalls, 0, 'Switching panels must not send the prepared prompt')
      await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
      await control.command('click', `${CARD} [data-testid="request-user-input-discuss"]`)
      await control.command('waitFor', sideComposer, {
        text: '请先讨论项目成员方案。',
        visible: true,
      })
      assert.equal(await control.command('getValue', sideComposer), editedPrompt)
      await captureScreenshot(control, 'question-discussion-02a3-restored-draft.png', 'body')
      await verifyQuestionDiscussionTabs({
        control,
        source,
        dialog: DIALOG,
        composer: sideComposer,
        draft: editedPrompt,
        captureScreenshot,
      })
      assert.equal(discussionCalls, 0, 'Task and tab switching must not send the prepared prompt')
      await control.command('click', `${DIALOG} [data-testid="question-discussion-close"]`)
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
      await control.command('waitFor', sideComposer, {
        text: '请先讨论项目成员方案。',
        visible: true,
      })
      assert.equal(
        await control.command('getValue', sideComposer),
        editedPrompt,
        'Unsent edits must be shared across entry points'
      )
      assert.equal(discussionCalls, 0, 'Cross-entry draft editing must not send')
      await captureScreenshot(control, 'question-discussion-02b-shared-unsent-prompt.png', 'body')
      await control.command('click', `${DIALOG} [data-testid="question-discussion-close"]`)
      await control.command('click', '[data-testid="workspace-tab-select-pending-interactions"]')
      await control.command('click', `${PAGE} [data-testid="interaction-open-original"]`)
      await control.command('waitFor', CARD, { text: QUESTION, visible: true })
      await control.command('click', `${CARD} [data-testid="request-user-input-discuss"]`)
      await control.command('waitFor', sideComposer, {
        text: '请先讨论项目成员方案。',
        visible: true,
      })
      await control.command('clickWhenEnabled', `${SIDE} [data-testid="send-message-button"]`)
      await control.command('waitFor', `${SIDE} [data-testid="message-assistant"]`, {
        text: ADVICE,
        visible: true,
      })
      assert.equal(finalAnswers, 0, 'Opening discussion cannot answer the original question')
      const [originalCard] = JSON.parse(await control.command('getElementMetrics', CARD))
      const [discussionPanel] = JSON.parse(await control.command('getElementMetrics', DIALOG))
      assert.ok(
        originalCard.right <= discussionPanel.left + 1,
        'Discussion must sit beside the original question without covering it'
      )
      await captureScreenshot(control, 'question-discussion-02-discuss-options.png', 'body')
      await control.command('fill', sideComposer, { value: FOLLOW_UP })
      await control.command('clickWhenEnabled', `${SIDE} [data-testid="send-message-button"]`)
      await control.command('waitFor', `${SIDE} [data-testid="message-assistant"]`, {
        text: CONCLUSION,
        visible: true,
      })
      await captureScreenshot(control, 'question-discussion-03-follow-up.png', 'body')
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
      await control.command('selectText', `${SIDE} [data-testid="message-assistant"]`, {
        value: SELECTED,
      })
      await control.command('waitFor', FILL_SELECTION, { visible: true })
      const [fillButton] = JSON.parse(await control.command('getElementMetrics', FILL_SELECTION))
      assert.ok(
        fillButton.left >= 0 &&
          fillButton.right <= fillButton.viewportWidth &&
          fillButton.bottom <= fillButton.viewportHeight,
        'Selected-text fill must stay reachable on a narrow screen'
      )
      await captureScreenshot(control, 'question-discussion-04a-narrow.png', 'body')
      await control.command('clickAt', 'body', {
        value: JSON.stringify({
          x: fillButton.left + fillButton.width / 2,
          y: fillButton.top + fillButton.height / 2,
        }),
      })
      await control.command(
        'waitFor',
        `${CARD} [data-testid="request-user-input-custom-question_1"]`,
        { visible: true }
      )
      await captureScreenshot(control, 'question-discussion-04a2-narrow-answer.png', 'body')
      await control.command('setMainWindowSize', 'body', { value: previousSize })
      await control.command(
        'clickWhenEnabled',
        `${CARD} [data-testid="request-user-input-discuss"]`
      )
      await waitForElementWidth(
        control,
        DIALOG,
        width => Math.abs(width - discussionPanel.width) < 1,
        'restored sidebar discussion'
      )
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
      await control.command('selectText', `${SIDE} [data-testid="message-assistant"]`, {
        value: SELECTED,
      })
      await control.command('clickWhenEnabled', FILL_SELECTION)
      const answer = `${CARD} [data-testid="request-user-input-custom-question_1"]`
      await control.command('waitFor', answer, { visible: true })
      assert.equal(await control.command('getValue', answer), SELECTED)
      await control.command('fill', answer, { value: CONCLUSION })
      assert.equal(finalAnswers, 0, 'Filling a draft cannot submit it')
      await captureScreenshot(control, 'question-discussion-05-editable-answer.png', 'body')
      await control.command(
        'clickWhenEnabled',
        `${CARD} [data-testid="request-user-input-submit-button"]`
      )
      await control.command('click', '[data-testid="workspace-tab-select-pending-interactions"]')
      await control.command('waitFor', `${PAGE} [data-testid="interactions-pending-count"]`, {
        text: '0',
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
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
      await control.command('click', '[data-testid="new-chat-button"]')
      const ordinaryWorkspace = join(workspacePath, 'question-collapse-send')
      await mkdir(ordinaryWorkspace, { recursive: true })
      await createSingleRootLocalProject(control, ordinaryWorkspace, '收起问题后继续沟通')
      await selectE2EModel(control)
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: MULTI_PROMPT })
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      await control.command('waitFor', CARD, { text: QUESTION, visible: true })
      await control.command('click', `${CARD} [data-testid="request-user-input-discuss"]`)
      const multiSize = await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 480, height: 760 }),
      })
      await waitForElementWidth(
        control,
        DIALOG,
        width => width <= 480,
        'multi-question narrow sidebar'
      )
      const target = `${DIALOG} [data-testid="question-discussion-question"]`
      await control.command('fill', target, { value: 'question_2' })
      const [selectBounds] = JSON.parse(await control.command('getElementMetrics', target))
      assert.ok(
        selectBounds.left >= 0 && selectBounds.right <= selectBounds.viewportWidth,
        'Long target questions must fit the narrow sidebar'
      )
      await captureScreenshot(control, 'question-discussion-08-multi-question-narrow.png', 'body')
      assert.equal(discussionCalls, 2, 'Opening a second question must only prefill its composer')
      await control.command('click', `${DIALOG} [data-testid="question-discussion-close"]`)
      await control.command('setMainWindowSize', 'body', { value: multiSize })
      await control.command('click', `${CARD} [data-testid="request-user-input-ignore-button"]`)
      await control.command('waitFor', expandQuestion, { visible: true })
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: ORDINARY_MESSAGE })
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        { text: COMPLETE, visible: true }
      )
      await control.command('waitFor', expandQuestion, { visible: false })
      await control.command('waitFor', CARD, { visible: false })
      assert.equal(
        ordinaryAnswers,
        1,
        'Only a delivered ordinary message should dismiss the old question'
      )
      await captureScreenshot(
        control,
        'question-discussion-07-message-dismissed-question.png',
        'body'
      )
      await writeFile(
        join(resultDir, 'question-discussion-user-story.json'),
        JSON.stringify(
          { source, discussionCalls, finalAnswers, ordinaryAnswers, result: 'passed' },
          null,
          2
        )
      )
      active = false
    },
  }
}
