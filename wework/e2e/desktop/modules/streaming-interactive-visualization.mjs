import { selectedToolCall } from './model-tool-calls.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchLocalRuntimeJson } from './runtime-request.mjs'
import { createVisualizationFixtureWriteCommand } from './visualization-fixture-command.mjs'
import { selectWorkbenchTheme } from './appearance-theme.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  COMPOSER_SELECTOR,
  assistantMessage,
  functionCall,
  latestModelInputText,
  openNewChatWithE2EModel,
  requestContainsToolOutputForCall,
  responseCompleted,
  responseCreated,
  selectShellTool,
  sse,
  waitForRuntimePaneReadyToSend,
  waitForVisualizationBlob,
} from './streaming-text-fixture.mjs'

const PROMPT = 'WEWORK_INTERACTIVE_VISUALIZATION_PROTOCOL'
const TITLE = 'Interactive interest calculator'
const CALL_ID = 'wework-interactive-visualization-write'
const FILE_WRITTEN = 'WEWORK_INTERACTIVE_VISUALIZATION_FILE_WRITTEN'
const FRAME = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="codex-inline-visualization-frame"][title="${TITLE}"]`
const HTML = `<section>
  <h2>${TITLE}</h2>
  <label for="principal">Principal</label>
  <input id="principal" type="number" value="100000">
  <label for="rate">Annual rate</label>
  <input id="rate" type="range" min="0" max="10" step="0.5" value="5.5">
  <output id="interest" aria-live="polite"></output>
  <span id="isolation"></span>
</section>
<script>
  const principal = document.querySelector('#principal')
  const rate = document.querySelector('#rate')
  const interest = document.querySelector('#interest')
  const calculate = () => {
    interest.textContent = (Number(principal.value) * Number(rate.value) / 100 * 7 / 365).toFixed(2)
  }
  principal.addEventListener('input', calculate)
  rate.addEventListener('input', calculate)
  try {
    parent.document.body
    document.querySelector('#isolation').textContent = 'parent-accessible'
  } catch {
    document.querySelector('#isolation').textContent = 'isolated'
  }
  calculate()
</script>`

export function createInteractiveVisualizationChecks({
  workspacePath,
  uiTimeoutMs,
  captureScreenshot,
}) {
  const directory = join(workspacePath, 'outputs', 'visualizations', 'interactive-e2e')
  const file = join(directory, 'interest-calculator.html')
  let stage = 'initial'

  async function frameAction(control, action, selector, value) {
    const origin = await control.command('getLocationOrigin', 'body')
    const url = await control.command('getAttribute', FRAME, { value: 'src' })
    const result = await fetchLocalRuntimeJson(
      control,
      `${origin}/wework/electron-host/v1/invoke`,
      {
        timeoutMs: uiTimeoutMs,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          capability: 'e2e.inlineVisualizationFrame',
          params: { url, action, selector, value },
        }),
      }
    )
    assert.equal(result.ok, true, JSON.stringify(result.error))
    return result.result
  }

  async function waitForInterest(control, expected) {
    const deadline = Date.now() + uiTimeoutMs
    let actual
    do {
      actual = await frameAction(control, 'text', '#interest')
      if (actual === expected) return
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    assert.equal(actual, expected, 'The calculator did not execute its input handler')
  }

  return {
    async handleModelRequest(body, response, id) {
      if (
        !latestModelInputText(body).includes(PROMPT) &&
        !(stage === 'awaiting-tool-output' && requestContainsToolOutputForCall(body, CALL_ID))
      )
        return false
      if (stage === 'initial') {
        const developerInstructions = (body.input ?? [])
          .filter(item => item?.role === 'developer')
          .flatMap(item => item.content ?? [])
          .map(content => content?.text ?? '')
          .join('\n')
        assert.ok(
          developerInstructions.includes('Wework inline visualizations:'),
          'The real model request did not receive the visualization capability instructions'
        )
        assert.ok(
          developerInstructions.includes('visualize'),
          'The visualization instructions did not teach the supported content-reference protocol'
        )
        const tool = selectShellTool(
          body,
          workspacePath,
          createVisualizationFixtureWriteCommand({
            file,
            html: `${HTML}\n`,
            marker: FILE_WRITTEN,
          }),
          10_000
        )
        stage = 'awaiting-tool-output'
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([responseCreated(id), ...selectedToolCall(CALL_ID, tool), responseCompleted(id)])
        )
        return true
      }

      assert.equal(stage, 'awaiting-tool-output')
      assert.ok(
        requestContainsToolOutputForCall(body, CALL_ID),
        'The real shell tool did not return its visualization write result'
      )
      const output = body.input.find(
        item =>
          ['function_call_output', 'custom_tool_call_output'].includes(item?.type) &&
          item.call_id === CALL_ID
      )
      assert.ok(JSON.stringify(output.output).includes(FILE_WRITTEN))
      assert.equal(await readFile(file, 'utf8'), `${HTML}\n`)
      stage = 'complete'
      const reply = assistantMessage(
        `visualize${JSON.stringify({ path: file, title: TITLE, mode: 'wide' })}`,
        'final_answer'
      )
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(sse([responseCreated(id), reply, responseCompleted(id, [reply.item])]))
      return true
    },

    async verify(control) {
      await openNewChatWithE2EModel(control, uiTimeoutMs)
      await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
        {
          enabled: true,
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', FRAME, { timeoutMs: uiTimeoutMs })
      await waitForVisualizationBlob(control, FRAME, uiTimeoutMs)
      await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
      await waitForInterest(control, '105.48')
      assert.equal(await frameAction(control, 'text', '#isolation'), 'isolated')
      await frameAction(control, 'fill', '#principal', '200000')
      await waitForInterest(control, '210.96')
      await frameAction(control, 'fill', '#rate', '6.5')
      await waitForInterest(control, '249.32')

      const originalSource = await control.command('getAttribute', FRAME, { value: 'src' })
      for (const themeId of ['tokyo-night', 'matrix']) {
        await selectWorkbenchTheme(control, { themeId, timeoutMs: uiTimeoutMs })
        await control.command('waitFor', FRAME, { timeoutMs: uiTimeoutMs })
        assert.equal(
          await control.command('getAttribute', FRAME, { value: 'src' }),
          originalSource,
          'A named theme change reloaded the interactive visualization'
        )
        await waitForInterest(control, '249.32')
        assert.equal(await frameAction(control, 'value', '#principal'), '200000')
        assert.equal(await frameAction(control, 'value', '#rate'), '6.5')
        const expected = themeId === 'tokyo-night' ? 'rgb(26 27 38)' : 'rgb(4 8 5)'
        const deadline = Date.now() + uiTimeoutMs
        let background
        do {
          const style = await frameAction(control, 'attribute', 'html', 'style')
          background = style?.match(/--background:\s*([^;]+)/)?.[1]?.trim()
          if (background === expected) break
          await new Promise(resolve => setTimeout(resolve, 50))
        } while (Date.now() < deadline)
        assert.equal(background, expected, 'The live iframe did not receive the selected palette')
        await captureScreenshot(
          control,
          `appearance-${themeId}-interactive-visualization.png`,
          'body'
        )
      }
      await selectWorkbenchTheme(control, { timeoutMs: uiTimeoutMs })

      const readyCount = control.readyCount
      await control.command('reloadMainWindow', 'body')
      await control.awaitReadyAfter(readyCount)
      await control.command('waitFor', FRAME, { timeoutMs: uiTimeoutMs })
      await waitForVisualizationBlob(control, FRAME, uiTimeoutMs)
      await waitForInterest(control, '105.48')
      assert.equal(await frameAction(control, 'text', '#isolation'), 'isolated')
      await frameAction(control, 'fill', '#principal', '300000')
      await waitForInterest(control, '316.44')
      assert.equal(stage, 'complete')
    },
  }
}
