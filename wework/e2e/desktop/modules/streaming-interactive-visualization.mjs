import { selectedToolCall } from './model-tool-calls.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchLocalRuntimeJson } from './runtime-request.mjs'
import { createVisualizationFixtureWriteCommand } from './visualization-fixture-command.mjs'
import { selectWorkbenchTheme } from './appearance-theme.mjs'
import { withTimeout, WORKBENCH_READY_TIMEOUT_MS } from './shared.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { toolOutputText } from './response-protocol.mjs'
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
const SKILL_CALL_ID = 'wework-interactive-visualization-skill'
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

async function detachVisualizationTab(control, uiTimeoutMs) {
  const main = { command: (...args) => control.commandForWindow('main', ...args) }
  const selectedTab = '[data-testid="workspace-tab-strip"] [role="tab"][aria-selected="true"]'
  const tabId = await main.command('getAttribute', selectedTab, { value: 'data-testid' })
  assert.ok(tabId?.startsWith('workspace-tab-select-'))
  const tab = `[data-testid="${tabId}"]`
  await main.command('contextMenu', tab)
  const readyCount = control.readyCount
  await main.command('click', '[data-testid="workspace-tab-open-new-window"]')
  const ready = await withTimeout(
    control.awaitReadyAfter(readyCount),
    WORKBENCH_READY_TIMEOUT_MS,
    'The visualization workspace window did not connect'
  )
  assert.ok(ready.windowLabel.startsWith('workspace-'))
  const detached = {
    windowLabel: ready.windowLabel,
    command: (...args) => control.commandForWindow(ready.windowLabel, ...args),
  }
  await detached.command('waitFor', FRAME, { timeoutMs: uiTimeoutMs })
  await waitForVisualizationBlob(detached, FRAME, uiTimeoutMs)
  control.activateWindow('main')
  // Transferring the task can select the interactions tab in the source window.
  // Settings is owned by a task workbench, so establish that owner through the UI.
  await main.command('click', '[data-testid="workspace-tab-add"]')
  await main.command('click', '[data-testid="workspace-tab-add-task"]')
  await main.command('waitFor', COMPOSER_SELECTOR, { visible: true, timeoutMs: uiTimeoutMs })
  return { main, detached, tab }
}

export function createInteractiveVisualizationChecks({
  workspacePath,
  uiTimeoutMs,
  captureScreenshot,
}) {
  const directory = join(workspacePath, 'outputs', 'visualizations', 'interactive-e2e')
  const file = join(directory, 'interest-calculator.html')
  let stage = 'initial'
  let skillPath

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
          params: { url, action, selector, value, windowLabel: control.windowLabel ?? 'main' },
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
        !(
          ['awaiting-skill-output', 'awaiting-tool-output'].includes(stage) &&
          requestContainsToolOutputForCall(
            body,
            stage === 'awaiting-skill-output' ? SKILL_CALL_ID : CALL_ID
          )
        )
      )
        return false
      if (stage === 'initial') {
        const developerInstructions = (body.input ?? [])
          .filter(item => item?.role === 'developer')
          .flatMap(item => item.content ?? [])
          .map(content => content?.text ?? '')
          .join('\n')
        assert.ok(
          developerInstructions.includes('Wework host workflows:') &&
            developerInstructions.includes('relevant skill'),
          'The real model request did not receive progressive host skill routing'
        )
        assert.ok(
          JSON.stringify(body.input).includes('wework-runtime:visualize'),
          'The real model request did not advertise the visualization skill'
        )
        const encodedPath = Buffer.from(skillPath, 'utf8').toString('base64')
        const tool = selectShellTool(
          body,
          workspacePath,
          `node -e "const fs=require('node:fs');console.log(fs.readFileSync(Buffer.from(process.argv[1],'base64').toString('utf8'),'utf8'))" ${encodedPath}`,
          10_000
        )
        stage = 'awaiting-skill-output'
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(id),
            ...selectedToolCall(SKILL_CALL_ID, tool),
            responseCompleted(id),
          ])
        )
        return true
      }

      if (stage === 'awaiting-skill-output') {
        const instructions = toolOutputText(body, SKILL_CALL_ID)
        assert.ok(
          instructions?.includes('Wework inline visualizations:'),
          'The real skill read did not return the visualization capability instructions'
        )
        assert.ok(
          instructions.includes('visualize'),
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
      const catalog = await requestExecutor(
        control,
        'runtime.codex.app_server.request',
        { method: 'skills/list', params: { cwds: [workspacePath], forceReload: false } },
        uiTimeoutMs
      )
      const skills = catalog.data
        .flatMap(entry => entry.skills)
        .filter(skill => skill.name === 'wework-runtime:visualize' && skill.enabled)
      assert.equal(
        skills.length,
        1,
        'The native catalog must expose one enabled visualization skill'
      )
      skillPath = skills[0].path
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
      // Settings hides the conversation and may unmount virtualized messages.
      // Keep the calculator visible in its real workspace window while changing
      // themes through the main window, so this measures a live palette update.
      const { main, detached, tab } = await detachVisualizationTab(control, uiTimeoutMs)
      await waitForInterest(detached, '105.48')
      assert.equal(await frameAction(detached, 'text', '#isolation'), 'isolated')
      await frameAction(detached, 'fill', '#principal', '200000')
      await waitForInterest(detached, '210.96')
      await frameAction(detached, 'fill', '#rate', '6.5')
      await waitForInterest(detached, '249.32')

      const originalSource = await detached.command('getAttribute', FRAME, { value: 'src' })
      for (const themeId of ['tokyo-night', 'matrix']) {
        await selectWorkbenchTheme(main, { themeId, timeoutMs: uiTimeoutMs })
        await detached.command('waitFor', `html[data-appearance-theme="${themeId}"]`)
        await detached.command('waitFor', FRAME, { timeoutMs: uiTimeoutMs })
        assert.equal(
          await detached.command('getAttribute', FRAME, { value: 'src' }),
          originalSource,
          'A named theme change reloaded the interactive visualization'
        )
        await waitForInterest(detached, '249.32')
        assert.equal(await frameAction(detached, 'value', '#principal'), '200000')
        assert.equal(await frameAction(detached, 'value', '#rate'), '6.5')
        const expected = themeId === 'tokyo-night' ? 'rgb(26 27 38)' : 'rgb(4 8 5)'
        const deadline = Date.now() + uiTimeoutMs
        let background
        do {
          const style = await frameAction(detached, 'attribute', 'html', 'style')
          background = style?.match(/--background:\s*([^;]+)/)?.[1]?.trim()
          if (background === expected) break
          await new Promise(resolve => setTimeout(resolve, 50))
        } while (Date.now() < deadline)
        assert.equal(background, expected, 'The live iframe did not receive the selected palette')
        await captureScreenshot(
          detached,
          `appearance-${themeId}-interactive-visualization.png`,
          'body'
        )
      }
      await selectWorkbenchTheme(main, { timeoutMs: uiTimeoutMs })
      await detached.command('contextMenu', tab)
      await detached.command('click', '[data-testid="workspace-tab-return-to-main"]')
      control.activateWindow('main')
      await main.command('waitFor', FRAME, { timeoutMs: uiTimeoutMs })

      const readyCount = control.readyCount
      await main.command('reloadMainWindow', 'body')
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
