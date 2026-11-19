import assert from 'node:assert/strict'
import { verifyPlanConversationSwitch } from './streaming-text-plan-switch.mjs'
import { verifyConversationSwitchPosition } from './streaming-text-switch-stability.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  ASSISTANT_CONTENT_SELECTOR,
  COMPOSER_SELECTOR,
  assistantMessage,
  latestModelInputText,
  openNewChatWithE2EModel,
  responseCompleted,
  responseCreated,
  sse,
  streamingEvents,
  textDeltaEvents,
  waitForBottom,
  waitForRuntimePaneReadyToSend,
} from './streaming-text-fixture.mjs'

const PROMPT = 'WEWORK_RICH_TASK_SWITCH'
const RUNNING = 'TASK_SWITCH_RUNNING_TAIL'
const APPEND = '\n\nTASK_SWITCH_BACKGROUND_TAIL\n\n' + 'New background output. '.repeat(60)
const ANCHORS = `${ACTIVE_WORKBENCH_SELECTOR} [data-scroll-anchor]`
const CHUNKS = `${ACTIVE_WORKBENCH_SELECTOR} [data-markdown-window-chunk]`

function history(turn) {
  return Array.from({ length: 14 }, (_, index) =>
    [
      `## TASK_SWITCH_HISTORY_${turn}_SECTION_${index}`,
      '任务切换应保持阅读位置。代码、表格和段落使用实际排版高度。'.repeat(9 + (index % 4)),
      '- 第一条规则\n- **第二条规则**：包含较长的说明文字和 `inline_code`。\n- 第三条规则',
      '| State | Meaning |\n| --- | --- |\n| reading | Preserve the reader |\n| bottom | Follow new output |',
      '```typescript\n' +
        Array.from(
          { length: 3 + (index % 5) },
          (_, line) => `const entry${line} = { section: ${index}, enabled: true }`
        ).join('\n') +
        '\n```',
    ].join('\n\n')
  ).join('\n\n')
}

export function createRichTaskSwitchChecks({ resultDir, uiTimeoutMs, codexSqliteHome }) {
  let releaseAppend
  let releaseDone
  const append = new Promise(resolve => {
    releaseAppend = resolve
  })
  const done = new Promise(resolve => {
    releaseDone = resolve
  })
  return {
    async handleModelRequest(body, response, id) {
      const input = latestModelInputText(body)
      const turn = input.match(new RegExp(`${PROMPT}_HISTORY_(\\d+)`))?.[1]
      if (turn) {
        const reply = assistantMessage(history(turn), 'final_answer')
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(sse([responseCreated(id), reply, responseCompleted(id, [reply.item])]))
        return true
      }
      if (!input.includes(`${PROMPT}_RUNNING`)) return false
      const stream = streamingEvents(id, RUNNING + APPEND, 'final_answer')
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.flushHeaders()
      response.write(sse([...stream.start, ...textDeltaEvents(stream.itemId, RUNNING, 0)]))
      await append
      response.write(sse(textDeltaEvents(stream.itemId, APPEND, RUNNING.length)))
      await done
      response.end(sse(stream.finish))
      return true
    },
    async verify(control) {
      let address
      try {
        await openNewChatWithE2EModel(control, uiTimeoutMs)
        for (const turn of [1, 2]) {
          await control.command('fill', COMPOSER_SELECTOR, { value: `${PROMPT}_HISTORY_${turn}` })
          await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
          await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
            text: `TASK_SWITCH_HISTORY_${turn}_SECTION_13`,
          })
          await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
        }
        await control.command('fill', COMPOSER_SELECTOR, { value: `${PROMPT}_RUNNING` })
        await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
        await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: RUNNING })
        const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        address = debug.workbench?.currentRuntimeTask
        assert.ok(address?.taskId, 'The rich task-switch fixture has no task address')
        await waitForBottom(control, 'The running task before switching', uiTimeoutMs)
        await verifyConversationSwitchPosition(control, {
          address,
          resultDir,
          uiTimeoutMs,
          name: 'rich-bottom',
          pinned: true,
          anchorText: RUNNING,
        })
        const anchorText = 'TASK_SWITCH_HISTORY_2_SECTION_7'
        await control.command('scrollIntoViewAsUser', CHUNKS, { text: anchorText, value: 'start' })
        await control.command('waitFor', ANCHORS, { text: anchorText })
        await control.command('scrollIntoViewAsUser', ANCHORS, { text: anchorText, value: 'start' })
        await verifyConversationSwitchPosition(control, {
          address,
          resultDir,
          uiTimeoutMs,
          name: 'rich-reading',
          pinned: false,
          anchorText,
          whileAway: () => releaseAppend(),
        })
        await control.command(
          'click',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="scroll-to-bottom-button"]`
        )
        await waitForBottom(control, 'Explicitly resuming bottom following', uiTimeoutMs)
      } finally {
        releaseAppend()
        releaseDone()
      }
      await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
      await verifyPlanConversationSwitch(control, {
        address,
        resultDir,
        uiTimeoutMs,
        codexSqliteHome,
      })
    },
  }
}
