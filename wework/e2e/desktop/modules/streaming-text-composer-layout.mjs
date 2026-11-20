import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { customToolCall, toolOutputText } from './response-protocol.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  ASSISTANT_CONTENT_SELECTOR,
  COMPOSER_SELECTOR,
  SCROLLER_SELECTOR,
  assistantMessage,
  latestModelInputText,
  openNewChatWithE2EModel,
  responseCompleted,
  responseCreated,
  sse,
  streamingEvents,
  textDeltaEvents,
  waitForRuntimePaneReadyToSend,
} from './streaming-text-fixture.mjs'

const PROMPT = 'WEWORK_COMPOSER_LAYOUT_REGRESSION'
const CALL = 'composer-layout-write-file'
const READY = 'COMPOSER_LAYOUT_READY'
const DONE = 'COMPOSER_LAYOUT_DONE'
const FOLLOW_UP = 'COMPOSER_LAYOUT_FOLLOW_UP_DONE'
const FINAL = [
  '已修复代码，按选择的方式恢复启动：',
  '- 目标目录不存在时，创建目录。\n- 已有数据保持不变。\n- 工具完成后展示文件变更。',
  '消息和输入框应保持正确位置。'.repeat(22),
  DONE,
].join('\n\n')

export function createComposerLayoutChecks({ workspacePath, resultDir, uiTimeoutMs }) {
  let releaseFinal
  const final = new Promise(resolve => {
    releaseFinal = resolve
  })
  return {
    async handleModelRequest(body, response, id) {
      if (latestModelInputText(body).includes(`${PROMPT}_FOLLOW_UP`)) {
        const reply = assistantMessage(
          '按选择的方式恢复启动。\n\n- 没有目录时创建目录。\n- 原有数据保持不变。\n\n' + FOLLOW_UP,
          'final_answer'
        )
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(sse([responseCreated(id), reply, responseCompleted(id, [reply.item])]))
        return true
      }
      if (toolOutputText(body, CALL) !== null) {
        await final
        const stream = streamingEvents(id, FINAL, 'final_answer')
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([...stream.start, ...textDeltaEvents(stream.itemId, FINAL), ...stream.finish])
        )
        return true
      }
      if (!latestModelInputText(body).includes(PROMPT)) return false
      assert.ok(
        body.tools.some(tool => tool.name === 'apply_patch'),
        'Codex must advertise apply_patch'
      )
      const patch =
        '*** Begin Patch\n*** Add File: composer-layout.ts\n+export const layout = true\n*** End Patch'
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(
        sse([
          responseCreated(id),
          assistantMessage(READY + '\n\n' + '检查任务消息、代码变更和输入框布局。'.repeat(14)),
          customToolCall(CALL, 'apply_patch', patch),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      const previous = JSON.parse(
        await control.command('setMainWindowSize', 'body', {
          value: JSON.stringify({ width: 1440, height: 900 }),
        })
      )
      let sampling = false
      let expired = false
      let sample
      try {
        await openNewChatWithE2EModel(control, uiTimeoutMs)
        await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
        await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
        await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, { text: READY })
        await control.command('startElementMetricsSampling', SCROLLER_SELECTOR, {
          value: '30000',
          target: '[data-message-row], [data-testid="desktop-floating-composer-card"]',
        })
        sampling = true
        releaseFinal()
        await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: DONE })
        await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
        assert.equal(
          await readFile(join(workspacePath, 'composer-layout.ts'), 'utf8'),
          'export const layout = true\n'
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="file-changes-card"]`
        )
        await control.command(
          'click',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="review-file-changes-button"]`
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="review-view-switcher-button"]`
        )
        await control.command('fill', COMPOSER_SELECTOR, {
          value: `${PROMPT}_FOLLOW_UP 逻辑不要太复杂，没有目录就创建目录。`,
        })
        await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
        await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: FOLLOW_UP })
        await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
      } finally {
        releaseFinal()
        if (sampling) {
          expired = JSON.parse(
            await control.command('getElementMetricsSample', SCROLLER_SELECTOR)
          ).done
          sample = JSON.parse(
            await control.command('stopElementMetricsSampling', SCROLLER_SELECTOR)
          )
          await writeFile(
            join(resultDir, 'composer-layout-frames.json'),
            JSON.stringify(sample, null, 2)
          )
        }
        await control.command('setMainWindowSize', 'body', { value: JSON.stringify(previous) })
      }
      assert.ok(sample?.frames.length >= 2, 'The layout transition must capture painted frames')
      assert.equal(expired, false, 'Layout sampling expired before the second turn completed')
      for (const frame of sample.frames) {
        const elements = frame.elements ?? []
        const composer = elements.at(-1)
        assert.ok(composer, 'The composer disappeared during message completion')
        const gap = frame.top + frame.height - composer.bottom
        assert.ok(
          gap >= -1 && gap <= 32,
          `The composer moved above the viewport bottom: ${JSON.stringify({ frame, gap })}`
        )
        const rows = elements.slice(0, -1).sort((left, right) => left.top - right.top)
        for (let index = 1; index < rows.length; index++) {
          assert.ok(
            rows[index].top >= rows[index - 1].bottom - 1,
            `Message rows overlap: ${JSON.stringify({ frame, index })}`
          )
        }
      }
    },
  }
}
