import assert from 'node:assert/strict'
import { waitForTopMetrics } from './conversation-layout.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  ASSISTANT_CONTENT_SELECTOR,
  COMPOSER_SELECTOR,
  SCROLLER_SELECTOR,
  assistantMessage,
  getSingleElementMetrics,
  latestModelInputText,
  openNewChatWithE2EModel,
  responseCompleted,
  responseCreated,
  sse,
  waitForBottom,
  waitForRuntimePaneReadyToSend,
} from './streaming-text-fixture.mjs'

const PROMPT = 'WEWORK_SCROLLBAR_READING_RESTORATION'
const END = 'SCROLLBAR_HISTORY_END'
const SCROLLBAR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-scrollbar"]`
const responseForTurn = turn =>
  [
    ...Array.from(
      { length: 24 },
      (_, index) =>
        `### Turn ${turn} section ${index + 1}\n\nParagraph ${index + 1}: ${'The reader can navigate this long conversation and return to the same position. '.repeat(12)}`
    ),
    `${END}_${turn}`,
  ].join('\n\n')

async function sampleScrollbarDrag(control, ratios) {
  const drag = JSON.parse(
    await control.command('sampleRapidMarkdownWindowing', SCROLLER_SELECTOR, {
      value: JSON.stringify({
        contentSelector: '[data-markdown-window-chunk]',
        scrollbarSelector: SCROLLBAR,
        framesPerRatio: 4,
        ratios,
      }),
    })
  )
  assert.equal(drag.frameCount, ratios.length * 4, 'Continuous scrollbar drag missed frames')
  assert.ok(
    drag.samples.every(sample => sample.scrollbarRatioError <= 2),
    `The thumb drifted from the pointer during drag: ${JSON.stringify(
      drag.samples
        .filter(sample => sample.scrollbarRatioError > 2)
        .map(({ ratio, frame, scrollbarRatioError, scrollTop, scrollHeight, clientHeight }) => ({
          ratio,
          frame,
          scrollbarRatioError,
          scrollTop,
          scrollHeight,
          clientHeight,
        }))
    )}`
  )
  assert.ok(
    drag.samples.every(
      sample =>
        sample.visiblePlaceholderCount === 0 &&
        sample.visibleRichChunkCount > 0 &&
        sample.hasVisibleText
    ),
    'Dragging exposed an unrendered or blank Markdown viewport'
  )
  return drag
}

async function verifySearchScrollbarInput(control) {
  const input = '[data-testid="conversation-find-input"]'
  await control.command('nativePress', COMPOSER_SELECTOR, {
    key: `${process.platform === 'darwin' ? 'Meta' : 'Control'}+F`,
  })
  await control.command('waitFor', input)
  await control.command('fill', input, { value: 'Turn 1 section 24' })
  await control.command('waitFor', '[data-testid="conversation-find-count"]', { text: '1' })
  await control.command('nativePress', input, { key: 'Enter' })
  await sampleScrollbarDrag(control, [0.85, 0.55, 0.25])
  assert.equal(await control.command('getValue', input), 'Turn 1 section 24')
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="conversation-find-retry"]')),
    0
  )
  await control.command('nativePress', input, { key: 'Escape' })
}

export function createConversationScrollbarChecks({ uiTimeoutMs }) {
  const scrollbar = SCROLLBAR
  return {
    async handleModelRequest(body, response, id) {
      const turn = latestModelInputText(body).match(new RegExp(`${PROMPT}_(\\d+)`))?.[1]
      if (!turn) return false
      const reply = assistantMessage(responseForTurn(turn), 'final_answer')
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(sse([responseCreated(id), reply, responseCompleted(id, [reply.item])]))
      return true
    },

    async verify(control) {
      await openNewChatWithE2EModel(control, uiTimeoutMs)
      for (let turn = 1; turn <= 4; turn += 1) {
        await control.command('fill', COMPOSER_SELECTOR, { value: `${PROMPT}_${turn}` })
        await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
        await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: `${END}_${turn}` })
        await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
      }
      const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const address = debug.workbench?.currentRuntimeTask
      assert.ok(address?.taskId, 'The scrollbar fixture has no task address')
      const bottom = await waitForBottom(control, 'The completed long conversation', uiTimeoutMs)
      assert.ok(bottom.scrollHeight > bottom.clientHeight * 2, 'The fixture must overflow')
      const ratios = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]
      const drag = await sampleScrollbarDrag(control, ratios)
      assert.ok(
        drag.initial.placeholderChunkCount > 0,
        'The fixture must retain distant windowed chunks'
      )
      await verifySearchScrollbarInput(control)

      await control.command('press', scrollbar, { key: 'Home' })
      await waitForTopMetrics(control, SCROLLER_SELECTOR, 'Scrollbar Home', uiTimeoutMs)
      await control.command('press', scrollbar, { key: 'End' })
      await waitForBottom(control, 'Scrollbar End', uiTimeoutMs)
      await control.command('press', scrollbar, { key: 'Home' })
      await waitForTopMetrics(control, SCROLLER_SELECTOR, 'The saved reading position', uiTimeoutMs)

      await openNewChatWithE2EModel(control, uiTimeoutMs)
      await control.command(
        'clickWhenEnabled',
        `[data-testid="runtime-local-task-row-${address.taskId}"]`
      )
      await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: 'Paragraph 1:' })
      await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
      await waitForTopMetrics(
        control,
        SCROLLER_SELECTOR,
        'The restored reading position',
        uiTimeoutMs
      )
      const track = await getSingleElementMetrics(control, scrollbar, 'The restored scrollbar')
      const thumb = await getSingleElementMetrics(
        control,
        `${scrollbar} [data-testid="desktop-workbench-scrollbar-thumb"]`,
        'The restored scrollbar thumb'
      )
      assert.ok(Math.abs(thumb.top - track.top) <= 2, 'The thumb must match the restored viewport')
    },
  }
}
