import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, selectE2EModel } from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  functionCall,
  latestModelInputText,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectShellToolCommand,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'

const PROJECT_NAME = '专注视图验证'
const ISSUE_NAME = '优化运行中卡片的进度展示'
const TASK_PROMPT = 'BOARD_FOCUS_VIEW_RUNNING_CARD_E2E'
const SHORT_PROCESS_TEXT = '正在读取运行中卡片的界面状态。'
const PROCESS_TEXT = [
  SHORT_PROCESS_TEXT,
  '已定位过程文本的数据来源。',
  '正在检查命令摘要是否移除 Shell 包装。',
  '准备验证执行阶段列的专注视图。',
  '等待界面稳定后完成视觉审查。',
].join('\n')
const TOOL_CALL_ID = 'board-focus-view-command'
const ACTIVE_BOARD = '[data-testid="cloud-todo-workspace"]'

function textDelta(itemId, text, offset) {
  return {
    type: 'response.output_text.delta',
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: text,
    offset,
  }
}

async function waitForValue(read, predicate, message, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}

function boardItemTestId(snapshot) {
  return snapshot.testIds.find(
    testId =>
      /^cloud-todo-card-(?!add-child-|assignee-|archive-|drop-|menu-|more-).+/u.test(testId) &&
      !testId.includes('activity-') &&
      !testId.includes('process-') &&
      !testId.includes('tool-line-')
  )
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workspacePath }) {
  let active = false
  let modelStage = 'initial'
  let appendProcessText
  const appendProcessTextPromise = new Promise(resolve => {
    appendProcessText = resolve
  })
  let finishModelResponse
  const finishModelResponsePromise = new Promise(resolve => {
    finishModelResponse = resolve
  })

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/v1/responses', '/responses'].includes(url.pathname)
      ) {
        return false
      }

      const body = await readRequestBody(request)
      const responseId = `board-focus-view-${Date.now()}`
      const inputText = latestModelInputText(body)

      if (modelStage === 'awaiting-tool-output' && requestContainsToolOutput(body, TOOL_CALL_ID)) {
        modelStage = 'holding-after-tool'
        await finishModelResponsePromise
        modelStage = 'complete'
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          createSse([
            responseCreated(responseId),
            assistantMessage('运行中卡片视觉验证已完成。'),
            responseCompleted(responseId),
          ])
        )
        return true
      }

      if (!inputText.includes(TASK_PROMPT)) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(createSse([responseCreated(responseId), responseCompleted(responseId)]))
        return true
      }

      assert.equal(modelStage, 'initial', `Unexpected board focus model stage: ${modelStage}`)
      modelStage = 'streaming-process'
      const stream = streamingTextEvents(responseId, PROCESS_TEXT)
      const command = `/bin/zsh -lc ${JSON.stringify("printf '正在验证运行中卡片'")}`
      const tool = selectShellToolCommand(body, command, workspacePath)

      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.flushHeaders()
      response.write(createSse(stream.start))
      response.write(createSse([textDelta(stream.itemId, SHORT_PROCESS_TEXT, 0)]))
      await appendProcessTextPromise
      response.write(
        createSse([
          textDelta(
            stream.itemId,
            PROCESS_TEXT.slice(SHORT_PROCESS_TEXT.length),
            SHORT_PROCESS_TEXT.length
          ),
          ...stream.finish.slice(0, -1),
          ...functionCall(TOOL_CALL_ID, tool.name, tool.arguments, 1),
          responseCompleted(responseId),
        ])
      )
      response.end()
      modelStage = 'awaiting-tool-output'
      return true
    },

    async verify(control) {
      active = true
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add"]')
      await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add-board"]')
      await control.command('waitFor', '[data-testid="cloud-project-add"]', {
        timeoutMs: uiTimeoutMs,
      })

      await control.command('click', '[data-testid="cloud-project-add"]')
      await control.command('waitFor', '[data-testid="cloud-project-name"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', '[data-testid="cloud-project-name"]', {
        value: PROJECT_NAME,
      })
      await control.command('click', '[data-testid="cloud-project-location-local"]')
      await control.command('click', '[data-testid="cloud-project-task-provider-local"]')
      await control.command('clickWhenEnabled', '[data-testid="cloud-project-create-confirm"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-project-header-title"]', {
        text: PROJECT_NAME,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-board-focus-running"]', {
        text: '专注视图',
        timeoutMs: uiTimeoutMs,
      })

      await control.command('click', '[data-testid="cloud-todo-column-empty-add-inbox"]')
      await control.command('waitFor', '[data-testid="cloud-todo-column-quick-create-inbox"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', '[data-testid="cloud-todo-column-quick-create-input-inbox"]', {
        value: ISSUE_NAME,
      })
      await control.command(
        'clickWhenEnabled',
        '[data-testid="cloud-todo-column-quick-create-confirm-inbox"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', '[data-testid^="cloud-todo-card-"]', {
        text: ISSUE_NAME,
        timeoutMs: uiTimeoutMs,
      })
      const createdSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_BOARD))
      const itemTestId = boardItemTestId(createdSnapshot)
      assert.ok(itemTestId, 'The board focus fixture did not create an Issue card')
      const itemId = itemTestId.slice('cloud-todo-card-'.length)
      const cardSelector = `[data-testid="${itemTestId}"]`

      await control.command('click', cardSelector)
      await control.command('waitFor', '[data-testid="cloud-todo-detail"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('select', '[data-testid="cloud-todo-detail-status"]', {
        value: 'pending',
      })
      await control.command('clickWhenEnabled', '[data-testid="cloud-todo-save"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-todo-save"]', {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clickWhenEnabled', '[data-testid="cloud-todo-create-task"]', {
        stableMs: 250,
        timeoutMs: uiTimeoutMs,
      })
      const taskComposer = '[data-testid="work-item-new-task-chat-panel"]'
      const taskInput = `${taskComposer} [data-testid="chat-message-input"][contenteditable="true"]`
      await control.command('waitFor', taskComposer, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', taskInput, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, taskComposer)
      if (
        Number(
          await control.command('getElementCount', taskComposer, {
            visible: true,
          })
        ) === 0
      ) {
        await control.command('click', cardSelector)
        await control.command('waitFor', '[data-testid="cloud-todo-detail"]', {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('clickWhenEnabled', '[data-testid="cloud-todo-create-task"]', {
          stableMs: 250,
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', taskInput, {
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
      }
      assert.match(
        await control.command('getText', `${taskComposer} [data-testid="model-selector-button"]`, {
          visible: true,
        }),
        /GPT 5\.6 Luna/u,
        'The reopened Issue task composer did not retain the E2E model'
      )
      await control.command('fill', taskInput, { value: TASK_PROMPT })
      await control.command('press', taskInput, { key: 'Enter' })

      const processSelector = `[data-testid="cloud-todo-card-process-${itemId}"]`
      const toolSelector = `[data-testid="cloud-todo-card-tool-line-${itemId}"]`
      const progressPopup = `[data-testid="cloud-todo-card-progress-popup-${itemId}"]`
      await control.command('waitFor', processSelector, {
        text: SHORT_PROCESS_TEXT,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="cloud-todo-panel-close"]', {
        visible: true,
      })
      await control.command('waitFor', '[data-testid="cloud-todo-panel-stack"]', {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', processSelector, {
        text: SHORT_PROCESS_TEXT,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('hover', '[data-testid="cloud-board-focus-running"]')

      const [shortProcessMetrics] = JSON.parse(
        await control.command('getElementMetrics', processSelector)
      )
      const shortProcessLineHeight = Number.parseFloat(
        await control.command('getComputedStyleValue', processSelector, {
          value: 'line-height',
        })
      )
      assert.ok(
        shortProcessMetrics.height <= shortProcessLineHeight + 1,
        `A one-line process reserved blank rows: ${JSON.stringify({
          metrics: shortProcessMetrics,
          lineHeight: shortProcessLineHeight,
        })}`
      )
      await captureScreenshot(control, '01-running-card-one-line-no-blank.png', ACTIVE_BOARD)

      appendProcessText()
      await control.command('waitFor', processSelector, {
        text: '等待界面稳定后完成视觉审查。',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', toolSelector, {
        text: '正在验证运行中卡片',
        timeoutMs: uiTimeoutMs,
      })
      const compactProcessClass = await control.command('getAttribute', processSelector, {
        value: 'class',
      })
      assert.ok(compactProcessClass.includes('line-clamp-3'))
      const commandText = await control.command('getText', toolSelector)
      assert.ok(commandText.includes("printf '正在验证运行中卡片'"))
      assert.ok(!commandText.includes('/bin/zsh'), 'The card exposed the Shell wrapper path')
      await captureScreenshot(
        control,
        '02-running-card-compact-process-and-command.png',
        ACTIVE_BOARD
      )

      await control.command('scrollIntoView', cardSelector, { visible: true })
      await control.command('hover', '[data-testid="cloud-board-focus-running"]')
      await new Promise(resolve => setTimeout(resolve, 300))
      const [cardBeforeHover] = JSON.parse(await control.command('getElementMetrics', cardSelector))
      const transformBeforeHover = await control.command(
        'getComputedStyleValue',
        `[data-testid="cloud-todo-card-drop-${itemId}"]`,
        { value: 'transform' }
      )
      await control.command('hover', cardSelector, { visible: true })
      await control.command('waitFor', progressPopup, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await new Promise(resolve => setTimeout(resolve, 1_000))
      await control.command('waitFor', progressPopup, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      const popupText = await control.command('getText', progressPopup)
      assert.ok(popupText.includes("printf '正在验证运行中卡片'"))
      assert.ok(
        !popupText.includes('/bin/zsh'),
        'The progress popup exposed the Shell wrapper path'
      )
      assert.ok(
        !popupText.includes('/opt/homebrew/bin/zsh'),
        'The progress popup exposed the outer Shell wrapper path'
      )
      const [cardAfterHover] = JSON.parse(await control.command('getElementMetrics', cardSelector))
      const transformAfterHover = await control.command(
        'getComputedStyleValue',
        `[data-testid="cloud-todo-card-drop-${itemId}"]`,
        { value: 'transform' }
      )
      assert.equal(cardAfterHover.top, cardBeforeHover.top, 'Hover shifted the card vertically')
      assert.equal(
        transformAfterHover,
        transformBeforeHover,
        'Hover applied an unstable transform to the card'
      )
      await captureScreenshot(control, '03-running-card-hover-stable.png', 'body')

      await control.command('hover', '[data-testid="cloud-board-focus-running"]')
      const [toolbarMetrics] = JSON.parse(
        await control.command('getElementMetrics', '[data-testid="cloud-board-toolbar"]')
      )
      const [viewActionsMetrics] = JSON.parse(
        await control.command('getElementMetrics', '[data-testid="cloud-board-view-actions"]')
      )
      assert.ok(
        toolbarMetrics.left +
          toolbarMetrics.width -
          viewActionsMetrics.left -
          viewActionsMetrics.width <=
          32,
        'The focus-view action group was not aligned to the right side of the board toolbar'
      )
      assert.equal(
        await control.command('getStyle', '[data-testid="cloud-todo-column-in_progress"]', {
          value: 'width',
        }),
        '292px',
        'The In progress column did not start at the standard width'
      )
      assert.equal(
        await control.command('getStyle', '[data-testid="cloud-todo-column-in_review"]', {
          value: 'width',
        }),
        '292px',
        'The In review column did not start at the standard width'
      )
      await control.command('click', '[data-testid="cloud-board-focus-running"]')
      assert.equal(
        await control.command('getAttribute', '[data-testid="cloud-board-focus-running"]', {
          value: 'aria-pressed',
        }),
        'true',
        'The focus-view toggle did not enter its active state'
      )
      assert.equal(
        await control.command('getStyle', '[data-testid="cloud-todo-column-in_progress"]', {
          value: 'width',
        }),
        '480px',
        'The focus view did not widen the In progress column'
      )
      assert.equal(
        await control.command('getStyle', '[data-testid="cloud-todo-column-in_review"]', {
          value: 'width',
        }),
        '480px',
        'The focus view did not widen the In review column'
      )
      assert.equal(
        await control.command('getStyle', '[data-testid="cloud-todo-column-pending"]', {
          value: 'width',
        }),
        '292px',
        'The focus view unexpectedly widened the Pending column'
      )
      const focusedProcessClass = await control.command('getAttribute', processSelector, {
        value: 'class',
      })
      assert.ok(focusedProcessClass.includes('line-clamp-[8]'))
      await captureScreenshot(control, '04-running-card-focus-view.png', ACTIVE_BOARD)

      await control.command('click', '[data-testid="cloud-board-group-by"]')
      await control.command('click', '[data-testid="cloud-board-group-option-priority"]')
      await control.command('waitFor', '[data-testid="cloud-board-focus-running"]', {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      const [priorityCardMetrics] = JSON.parse(
        await control.command('getElementMetrics', cardSelector)
      )
      const [priorityBoardMetrics] = JSON.parse(
        await control.command('getElementMetrics', '[data-testid="cloud-board-scroll"]')
      )
      assert.ok(
        priorityCardMetrics.left >= priorityBoardMetrics.left,
        'Switching grouping retained a stale horizontal scroll position'
      )
      await captureScreenshot(control, '05-focus-view-hidden-for-priority-group.png', ACTIVE_BOARD)

      await control.command('click', '[data-testid="cloud-board-group-by"]')
      await control.command('click', '[data-testid="cloud-board-group-option-status"]')
      await control.command('waitFor', '[data-testid="cloud-board-focus-running"]', {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getAttribute', '[data-testid="cloud-board-focus-running"]', {
          value: 'aria-pressed',
        }),
        'true',
        'The focus view was not restored after returning to status grouping'
      )
      assert.equal(
        await control.command('getStyle', '[data-testid="cloud-todo-column-in_progress"]', {
          value: 'width',
        }),
        '480px',
        'The restored focus view did not widen the In progress column'
      )
      assert.equal(
        await control.command('getStyle', '[data-testid="cloud-todo-column-in_review"]', {
          value: 'width',
        }),
        '480px',
        'The restored focus view did not widen the In review column'
      )
      await captureScreenshot(control, '06-focus-view-restored.png', ACTIVE_BOARD)

      finishModelResponse()
      await waitForValue(
        () => Promise.resolve(modelStage),
        stage => stage === 'complete',
        'The board focus fixture did not finish after releasing the model response',
        uiTimeoutMs
      )
      active = false
    },

    diagnostics() {
      return { active, modelStage }
    },
  }
}
