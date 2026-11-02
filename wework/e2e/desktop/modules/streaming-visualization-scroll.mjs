import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchLocalRuntimeJson } from './runtime-request.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  COMPOSER_SELECTOR,
  SCROLLER_SELECTOR,
  assistantMessage,
  distanceFromBottom,
  distanceFromTop,
  functionCall,
  getSingleElementMetrics,
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

const PROMPT = 'WEWORK_INLINE_VISUALIZATION_NATIVE_WHEEL'
const TITLE = 'Visualization native wheel regression'
const CALL_ID = 'wework-visualization-scroll-write'
const WRITTEN = 'WEWORK_VISUALIZATION_SCROLL_FILE_WRITTEN'
const FRAME = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="codex-inline-visualization-frame"][title="${TITLE}"]`
const HTML = `<section id="scroll-fixture">
  <style>
    #scroll-fixture { display:grid;gap:6px; }
    #blank { min-height:72px;background:var(--muted); }
    #panel { height:104px;overflow:auto;border:1px solid var(--border); }
    #panel-content { height:604px;background:linear-gradient(var(--card),var(--muted)); }
    #wheel-control { min-height:44px;color:var(--foreground);background:var(--card); }
  </style>
  <h2>${TITLE}</h2>
  <div id="blank" aria-label="Non-scrollable visualization area"></div>
  <div id="panel" tabindex="0" aria-label="Scrollable visualization panel">
    <div id="panel-content">Scrollable panel start</div>
  </div>
  <button id="wheel-control" type="button" data-wheel-count="0">Control owns its wheel input</button>
</section>
<script>
  const wheelControl = document.getElementById('wheel-control')
  wheelControl.addEventListener('wheel', event => {
    event.preventDefault()
    wheelControl.dataset.wheelCount = String(Number(wheelControl.dataset.wheelCount) + 1)
  }, { passive: false })
</script>`

const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const pause = duration => new Promise(resolve => setTimeout(resolve, duration))
const surroundingText = position =>
  Array.from(
    { length: 30 },
    (_, index) =>
      `${position} paragraph ${index + 1}. This conversation has enough real Markdown before the final visualization to scroll upward from its automatically pinned bottom position.`
  ).join('\n\n')

export function createVisualizationScrollChecks({ workspacePath, uiTimeoutMs }) {
  const directory = join(workspacePath, 'outputs', 'visualizations', 'scroll-e2e')
  const file = join(directory, 'wheel-fixture.html')
  let stage = 'initial'

  async function frameAction(control, action, selector, extra = {}) {
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
          params: { url, action, selector, ...extra },
        }),
      }
    )
    assert.equal(result.ok, true, JSON.stringify(result.error))
    return result.result
  }

  const outerMetrics = control =>
    getSingleElementMetrics(control, SCROLLER_SELECTOR, 'Visualization conversation viewport')
  const panelMetrics = control => frameAction(control, 'metrics', '#panel')
  const wheel = (control, selector, deltaY) => frameAction(control, 'wheel', selector, { deltaY })

  async function waitFor(check, description) {
    const deadline = Date.now() + uiTimeoutMs
    do {
      const result = await check()
      if (result) return result
      await pause(50)
    } while (Date.now() < deadline)
    assert.fail(description)
  }

  async function centerFrame(control) {
    await control.command('scrollIntoViewAsUser', FRAME)
    await control.command('waitFor', FRAME, { stableMs: 250, timeoutMs: uiTimeoutMs })
  }

  async function verifyBlankAreaWheel(control) {
    const pinned = await waitFor(async () => {
      const outer = await outerMetrics(control)
      const frame = await getSingleElementMetrics(control, FRAME, 'Pinned visualization frame')
      const blank = await frameAction(control, 'metrics', '#blank')
      const blankTop = frame.top + blank.rect.top
      const blankBottom = frame.top + blank.rect.bottom
      return distanceFromBottom(outer) <= 2 &&
        frame.top >= outer.top - 1 &&
        frame.bottom <= outer.bottom + 1 &&
        blankTop >= outer.top &&
        blankBottom <= outer.bottom
        ? { outer, blankTop, blankBottom }
        : null
    }, 'The completed visualization was not fully visible at the automatically pinned conversation bottom')
    assert.ok(distanceFromBottom(pinned.outer) <= 2)
    assert.ok(pinned.blankBottom > pinned.blankTop, 'The pinned HTML blank area was not visible')
    await control.command('startScrollStabilitySampling', FRAME, {
      value: JSON.stringify({ durationMs: 1200, scrollerSelector: SCROLLER_SELECTOR }),
    })
    for (let index = 0; index < 6; index += 1) {
      await wheel(control, '#blank', -24)
      await pause(80)
    }
    const sample = await waitFor(async () => {
      const sample = JSON.parse(await control.command('getScrollStabilitySample', FRAME))
      return sample.done ? sample : null
    }, 'Visualization wheel stability sampling did not finish')
    assert.equal(sample.missingFrames, 0, 'The visualization disappeared during native wheel input')
    assert.ok(
      sample.frames.length >= 5,
      'Native wheel input did not produce enough position samples'
    )
    for (let index = 1; index < sample.frames.length; index += 1) {
      const previous = sample.frames[index - 1]
      const current = sample.frames[index]
      assert.ok(
        current.anchorTop >= previous.anchorTop - 2,
        `Visualization wheel input bounced backwards: ${previous.anchorTop} -> ${current.anchorTop}`
      )
    }
    const first = sample.frames[0]
    const last = sample.frames.at(-1)
    assert.ok(
      last.anchorTop - first.anchorTop >= 80,
      'Wheel input over blank HTML did not scroll the conversation upward'
    )
    assert.ok(
      distanceFromTop(first) - distanceFromTop(last) >= 80,
      'The outer conversation did not retain its upward scroll'
    )
  }

  async function verifyNestedPanelWheel(control) {
    await centerFrame(control)
    await wheel(control, '#blank', -72)
    await waitFor(
      async () => distanceFromBottom(await outerMetrics(control)) >= 50,
      'The nested panel test did not establish space for downward conversation scrolling'
    )
    const outerBefore = await outerMetrics(control)
    const panelBefore = await panelMetrics(control)
    assert.ok(
      panelBefore.scrollHeight > panelBefore.clientHeight,
      'The fixture panel is not scrollable'
    )
    assert.equal(panelBefore.scrollTop, 0)
    let panel = panelBefore
    for (
      let index = 0;
      index < 8 && panel.scrollHeight - panel.clientHeight - panel.scrollTop > 1;
      index += 1
    ) {
      const previousTop = panel.scrollTop
      await wheel(control, '#panel', 100)
      let lastTop = previousTop
      let stableSamples = 0
      panel = await waitFor(async () => {
        const next = await panelMetrics(control)
        stableSamples = Math.abs(next.scrollTop - lastTop) <= 0.5 ? stableSamples + 1 : 0
        lastTop = next.scrollTop
        return next.scrollTop > previousTop + 1 && stableSamples >= 2 ? next : null
      }, 'Native wheel input did not scroll the nested HTML panel')
      const outer = await outerMetrics(control)
      assert.ok(
        Math.abs(distanceFromTop(outer) - distanceFromTop(outerBefore)) <= 2,
        'The conversation scrolled before the nested HTML panel reached its boundary'
      )
    }
    assert.ok(
      panel.scrollHeight - panel.clientHeight - panel.scrollTop <= 1,
      'The nested HTML panel never reached its bottom boundary'
    )
    const boundaryOuter = await outerMetrics(control)
    await wheel(control, '#panel', 48)
    await waitFor(async () => {
      const outer = await outerMetrics(control)
      return distanceFromTop(outer) > distanceFromTop(boundaryOuter) + 8
    }, 'Wheel input at the nested panel boundary did not scroll the outer conversation')
  }

  async function verifyPreventedWheel(control) {
    await centerFrame(control)
    await wheel(control, '#blank', -24)
    await waitFor(
      async () => distanceFromBottom(await outerMetrics(control)) >= 16,
      'The control test did not establish space to detect an incorrectly forwarded wheel'
    )
    const outerBefore = await outerMetrics(control)
    const panelBefore = await panelMetrics(control)
    await wheel(control, '#wheel-control', 80)
    await waitFor(async () => {
      const count = await frameAction(control, 'attribute', '#wheel-control', {
        value: 'data-wheel-count',
      })
      return Number(count) > 0
    }, 'The HTML control did not receive its native wheel input')
    await pause(250)
    const outerAfter = await outerMetrics(control)
    assert.ok(
      Math.abs(distanceFromTop(outerAfter) - distanceFromTop(outerBefore)) <= 2,
      'A control that prevented wheel input still scrolled the outer conversation'
    )
    assert.equal((await panelMetrics(control)).scrollTop, panelBefore.scrollTop)
  }

  return {
    async handleModelRequest(body, response, id) {
      if (
        !latestModelInputText(body).includes(PROMPT) &&
        !(stage === 'awaiting-tool-output' && requestContainsToolOutputForCall(body, CALL_ID))
      )
        return false
      if (stage === 'initial') {
        const tool = selectShellTool(
          body,
          workspacePath,
          `set -e\nmkdir -p ${quote(directory)} && cat > ${quote(file)} <<'WEWORK_SCROLL_HTML'\n${HTML}\nWEWORK_SCROLL_HTML\nprintf '${WRITTEN}\\n'`,
          10_000
        )
        stage = 'awaiting-tool-output'
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(id),
            ...functionCall(CALL_ID, tool.name, tool.arguments),
            responseCompleted(id),
          ])
        )
        return true
      }
      assert.equal(stage, 'awaiting-tool-output')
      const output = body.input.find(
        item => item?.type === 'function_call_output' && item.call_id === CALL_ID
      )
      assert.ok(
        JSON.stringify(output?.output).includes(WRITTEN),
        'The real shell did not create the wheel fixture'
      )
      assert.equal(await readFile(file, 'utf8'), `${HTML}\n`)
      stage = 'complete'
      const reply = assistantMessage(
        [
          surroundingText('Before'),
          `visualize${JSON.stringify({ path: file, title: TITLE })}`,
        ].join('\n\n'),
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
      await verifyBlankAreaWheel(control)
      await verifyNestedPanelWheel(control)
      await verifyPreventedWheel(control)
      assert.equal(stage, 'complete')
    },
  }
}
