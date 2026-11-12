import { selectedToolCall } from './model-tool-calls.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchLocalRuntimeJson } from './runtime-request.mjs'
import { createVisualizationFixtureWriteCommand } from './visualization-fixture-command.mjs'
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
  addEventListener('DOMContentLoaded', () => {
    const fixture = document.getElementById('scroll-fixture')
    const panel = document.getElementById('panel')
    const root = document.scrollingElement
    const records = []
    let sequence = 0
    const describe = element => element instanceof Element ? element.id || element.tagName.toLowerCase() : null
    fixture.dataset.wheelEvents = '[]'
    // The host registers its bridge before DOMContentLoaded; sample after its listener.
    addEventListener('wheel', event => {
      queueMicrotask(() => {
        records.push({
          sequence: ++sequence,
          trusted: event.isTrusted,
          target: describe(event.target),
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          cancelable: event.cancelable,
          defaultPrevented: event.defaultPrevented,
          clientX: event.clientX,
          clientY: event.clientY,
          panelScrollTop: panel.scrollTop,
          rootScrollTop: root.scrollTop,
          elementFromPoint: describe(document.elementFromPoint(event.clientX, event.clientY)),
        })
        if (records.length > 20) records.shift()
        fixture.dataset.wheelEvents = JSON.stringify(records)
      })
    }, { passive: true })
  }, { once: true })
</script>`

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
  let phase = 'setup'
  let samplingStarted = false
  let nestedAttempt = null
  const nativeWheels = []

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
  const wheel = async (control, selector, deltaY) => {
    const input = await frameAction(control, 'wheel', selector, { deltaY })
    nativeWheels.push({ selector, ...input })
    if (nativeWheels.length > 20) nativeWheels.shift()
    return input
  }

  async function failureDiagnostics(control) {
    const reads = {
      outer: async () => {
        const outer = await outerMetrics(control)
        return {
          ...outer,
          distanceFromTop: distanceFromTop(outer),
          distanceFromBottom: distanceFromBottom(outer),
        }
      },
      frame: () => getSingleElementMetrics(control, FRAME, 'Failed visualization frame'),
      blank: () => frameAction(control, 'metrics', '#blank'),
      panel: () => panelMetrics(control),
      root: () => frameAction(control, 'metrics', 'html'),
      wheelEvents: async () => {
        const value = await frameAction(control, 'attribute', '#scroll-fixture', {
          value: 'data-wheel-events',
        })
        return value === null ? null : JSON.parse(value)
      },
      sampler: async () => JSON.parse(await control.command('getScrollStabilitySample', FRAME)),
    }
    const results = await Promise.allSettled(Object.values(reads).map(async read => read()))
    return {
      phase,
      nestedAttempt,
      nativeWheels,
      ...Object.fromEntries(
        Object.keys(reads).map((key, index) => {
          const result = results[index]
          return [
            key,
            result.status === 'fulfilled'
              ? result.value
              : {
                  readError:
                    result.reason instanceof Error ? result.reason.message : String(result.reason),
                },
          ]
        })
      ),
    }
  }

  async function waitFor(check, description) {
    const deadline = Date.now() + uiTimeoutMs
    do {
      const result = await check()
      if (result) return result
      await pause(50)
    } while (Date.now() < deadline)
    assert.fail(typeof description === 'function' ? description() : description)
  }

  async function revealFrame(control, alignment = 'center') {
    await control.command('scrollIntoViewAsUser', FRAME, { value: alignment })
    await control.command('waitFor', FRAME, { stableMs: 250, timeoutMs: uiTimeoutMs })
  }

  async function verifyBlankAreaWheel(control) {
    let lastGeometry
    const pinned = await waitFor(
      async () => {
        const outer = await outerMetrics(control)
        const frame = await getSingleElementMetrics(control, FRAME, 'Pinned visualization frame')
        const blank = await frameAction(control, 'metrics', '#blank')
        const blankTop = frame.top + blank.rect.top
        const blankBottom = frame.top + blank.rect.bottom
        lastGeometry = {
          outer,
          frame,
          blank,
          blankTop,
          blankBottom,
          distanceFromBottom: distanceFromBottom(outer),
          distanceFromTop: distanceFromTop(outer),
        }
        return distanceFromBottom(outer) <= 2 &&
          frame.height < 480 &&
          frame.top >= outer.top - 1 &&
          frame.bottom <= outer.bottom + 1 &&
          blankTop >= outer.top &&
          blankBottom <= outer.bottom
          ? { outer, frame, blankTop, blankBottom }
          : null
      },
      () =>
        `The completed visualization was not fully visible at the automatically pinned conversation bottom: ${JSON.stringify(lastGeometry)}`
    )
    assert.ok(distanceFromBottom(pinned.outer) <= 2)
    assert.ok(pinned.blankBottom > pinned.blankTop, 'The pinned HTML blank area was not visible')
    assert.ok(
      pinned.frame.height < 480,
      `The compact visualization did not shrink below its initial iframe height: ${JSON.stringify(lastGeometry)}`
    )
    samplingStarted = true
    await control.command('startScrollStabilitySampling', FRAME, {
      value: JSON.stringify({ durationMs: uiTimeoutMs, scrollerSelector: SCROLLER_SELECTOR }),
    })
    for (let index = 0; index < 6; index += 1) {
      await wheel(control, '#blank', -24)
      await pause(80)
    }
    // Observe the full negative window after all native input has been sent.
    await pause(1200)
    const beforeStop = JSON.parse(await control.command('getScrollStabilitySample', FRAME))
    assert.equal(
      beforeStop.done,
      false,
      'Visualization wheel sampling expired before the complete input and observation window'
    )
    const sample = JSON.parse(await control.command('stopScrollStabilitySampling', FRAME))
    samplingStarted = false
    assert.ok(
      sample.frames.every(frame => frame.time < uiTimeoutMs),
      'Visualization wheel sampling expired before explicit completion'
    )
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
    await revealFrame(control)
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
      const remaining = panel.scrollHeight - panel.clientHeight - panel.scrollTop
      const deltaY = Math.min(100, remaining)
      const nativeWheel = await wheel(control, '#panel', deltaY)
      let lastTop = previousTop
      let stableSamples = 0
      nestedAttempt = { index, previousTop, deltaY, nativeWheel, panel }
      panel = await waitFor(
        async () => {
          const next = await panelMetrics(control)
          nestedAttempt.panel = next
          stableSamples = Math.abs(next.scrollTop - lastTop) <= 0.5 ? stableSamples + 1 : 0
          lastTop = next.scrollTop
          return next.scrollTop > previousTop + 1 && stableSamples >= 2 ? next : null
        },
        () =>
          `Native wheel input did not scroll the nested HTML panel: ${JSON.stringify(nestedAttempt)}`
      )
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
    await revealFrame(control, 'start')
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
          createVisualizationFixtureWriteCommand({ file, html: `${HTML}\n`, marker: WRITTEN }),
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
      const output = body.input.find(
        item =>
          ['function_call_output', 'custom_tool_call_output'].includes(item?.type) &&
          item.call_id === CALL_ID
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
      try {
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
        phase = 'blank'
        await verifyBlankAreaWheel(control)
        phase = 'nested-panel'
        await verifyNestedPanelWheel(control)
        phase = 'prevented-control'
        await verifyPreventedWheel(control)
        assert.equal(stage, 'complete')
      } catch (error) {
        const diagnostics = await failureDiagnostics(control)
        const suffix = `\nVisualization wheel diagnostics: ${JSON.stringify(diagnostics)}`
        if (error instanceof Error) {
          const originalStack = error.stack
          error.message += suffix
          error.stack = `${originalStack ?? error.name}${suffix}`
          throw error
        }
        throw new Error(`${String(error)}${suffix}`, { cause: error })
      } finally {
        if (samplingStarted) {
          await Promise.allSettled([
            Promise.resolve().then(() => control.command('stopScrollStabilitySampling', FRAME)),
          ])
        }
      }
    },
  }
}
