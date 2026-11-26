import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  ASSISTANT_CONTENT_SELECTOR,
  COMPOSER_SELECTOR,
  SCROLLER_SELECTOR,
  distanceFromBottom,
  getSingleElementMetrics,
  latestModelInputText,
  sse,
  streamingEvents,
  textDeltaEvents,
  waitForBottom,
  waitForRuntimePaneReadyToSend,
} from './streaming-text-fixture.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'
import {
  DEFAULT_STEP_TIMEOUT_MS as STEP_TIMEOUT,
  DESKTOP_CONTROL_DELIVERY_TIMEOUT_MS,
  DESKTOP_CONTROL_RESULT_GRACE_MS,
} from './shared.mjs'
import { verifyConversationSwitchPosition } from './streaming-text-switch-stability.mjs'

const PROMPT = 'WEWORK_STREAMING_PANEL_RESIZE'
const READING = 'PANEL_RESIZE_READING_POSITION'
const PARTIAL = 'PANEL_RESIZE_PARTIAL_TAIL'
const APPENDED = 'PANEL_RESIZE_APPENDED_TAIL'
const DONE = 'PANEL_RESIZE_COMPLETED'
const paragraph = index =>
  `Section ${index}: ${'This paragraph wraps differently when the right workspace opens. '.repeat(9)}`
const PREFIX = [
  ...Array.from({ length: 4 }, (_, index) => paragraph(index)),
  READING,
  ...Array.from({ length: 10 }, (_, index) => paragraph(index + 4)),
  PARTIAL,
].join('\n\n')
const APPEND = `\n\n${paragraph(14)}\n\n${APPENDED}`
const COMPLETE = `${PREFIX}${APPEND}\n\n${DONE}`
const ANCHORS = `${ASSISTANT_CONTENT_SELECTOR} [data-scroll-anchor]`
const TOGGLE =
  '[data-testid="workbench-main-header"] [data-testid="toggle-right-workspace-panel-button"]'
const SHELL = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-panel-shell"]`
const LIST = `${ACTIVE_WORKBENCH_SELECTOR} [data-conversation-message-list]`
const SCROLLBAR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-scrollbar"]`
const MARKER = 'streaming-panel-resize-anchor'
const HISTORY_READING = 'Turn 4 section 6'
const HISTORY_TAIL = 'Turn 4 section 24'

async function assertStreamActive(control) {
  await waitForWorkbenchDebugState(
    control,
    snapshot => snapshot.pane?.status?.isBusy === true,
    'The panel-resize fixture must keep the model turn active',
    STEP_TIMEOUT
  )
  assert.equal(
    await control.command('getAttribute', LIST, { value: 'data-conversation-virtualizer-enabled' }),
    'true',
    'The panel-resize fixture must exercise the virtualized conversation'
  )
}

async function collectFailure(failures, action) {
  try {
    await action()
  } catch (error) {
    failures.push(error)
  }
}

function throwFailures(failures, message) {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message, { cause: failures[0] })
}

async function toggleAndSample(control, { resultDir, name, open, pinned, marker = MARKER }) {
  let sample
  const failures = []
  const commandBudget =
    STEP_TIMEOUT + DESKTOP_CONTROL_DELIVERY_TIMEOUT_MS + DESKTOP_CONTROL_RESULT_GRACE_MS
  // Start acknowledgement, baseline read, toggle, panel state, anchor
  // visibility and stop are six commands. Each poll can finish with one
  // in-flight command.
  const pollBudget = STEP_TIMEOUT + commandBudget
  try {
    await control.command('startElementMetricsSampling', SCROLLER_SELECTOR, {
      value: String(6 * commandBudget + (pinned ? 2 : 1) * pollBudget),
      target: `[data-e2e-anchor-id="${marker}"], [data-conversation-message-list], [data-markdown-window-placeholder]`,
    })
    // This captures the pre-toggle frame and the first frame at the new width.
    const readWidths = async () => {
      const status = JSON.parse(
        await control.command('getElementMetricsSample', SCROLLER_SELECTOR, {
          value: 'recentWidths',
        })
      )
      assert.equal(
        status.done,
        false,
        `${name}: frame sampling expired before the width change finished`
      )
      return status
    }
    const { initialWidth } = await readWidths()
    assert.ok(initialWidth > 0, `${name}: the sampler has no visible baseline frame`)
    await control.command('clickWhenEnabled', TOGGLE)
    await control.command('waitFor', `${SHELL}[aria-hidden="${!open}"]`, {
      timeoutMs: STEP_TIMEOUT,
    })
    await waitForValue(
      readWidths,
      ({ recentWidths }) =>
        recentWidths.length === 2 &&
        recentWidths.every(width => (open ? width < initialWidth - 80 : width > initialWidth + 80)),
      `${name}: the changed conversation width was not painted`,
      STEP_TIMEOUT
    )
    if (pinned) await waitForBottom(control, `${name}: final bottom position`, STEP_TIMEOUT, 2)
    // Continue sampling after the width commits. Deferred row and Markdown
    // observers must not move the held response during this observation window.
    await control.command('waitFor', `[data-e2e-anchor-id="${marker}"]`, {
      visible: true,
      stableMs: 250,
      timeoutMs: STEP_TIMEOUT,
    })
  } catch (error) {
    failures.push(error)
  } finally {
    await collectFailure(failures, async () => {
      sample = JSON.parse(await control.command('stopElementMetricsSampling', SCROLLER_SELECTOR))
    })
    await collectFailure(failures, async () => {
      const diagnostics = JSON.parse(
        await control.command('getConversationDiagnosticsSnapshot', 'body')
      )
      await writeFile(
        join(resultDir, `conversation-panel-resize-${name}.json`),
        JSON.stringify({ sample, diagnostics, expired: sample?.expired }, null, 2)
      )
    })
  }
  throwFailures(failures, `${name}: frame sampling and diagnostics failed`)
  assert.equal(
    sample.expired,
    false,
    `${name}: frame sampling expired before the width change finished`
  )
  assert.ok(sample.frames.length >= 3, `${name}: not enough sampled animation frames`)
  const initial = sample.frames[0]
  const final = sample.frames.at(-1)
  const firstAnchor = initial.elements.find(element => element.anchorId === marker)
  assert.ok(firstAnchor, `${name}: the anchor must be mounted in the baseline frame`)
  const firstOffset = firstAnchor.top - initial.top
  let leftInitialWidth = false
  for (const frame of sample.frames) {
    const atInitialWidth = Math.abs(frame.clientWidth - initial.clientWidth) <= 1
    assert.ok(
      frame.connected && (atInitialWidth || Math.abs(frame.clientWidth - final.clientWidth) <= 1),
      `${name}: the conversation had an intermediate width or lost its viewport: ${JSON.stringify(frame)}`
    )
    assert.ok(
      !leftInitialWidth || !atInitialWidth,
      `${name}: the conversation returned to its baseline width: ${JSON.stringify(frame)}`
    )
    leftInitialWidth ||= !atInitialWidth
    assert.ok(
      frame.elements.some(element => element.conversationVirtualizerEnabled === 'true'),
      `${name}: virtualized rendering was lost during the resize`
    )
    const anchor = frame.elements.find(element => element.anchorId === marker)
    assert.ok(
      anchor &&
        anchor.identity === firstAnchor.identity &&
        anchor.height > 0 &&
        anchor.bottom > frame.top &&
        anchor.top < frame.top + frame.height,
      `${name}: the visible text anchor was lost or remounted: ${JSON.stringify(frame)}`
    )
    if (!pinned) {
      assert.ok(
        Math.abs(anchor.top - frame.top - firstOffset) <= 2,
        `${name}: the visible text moved relative to the viewport: ${JSON.stringify({ firstOffset, frame })}`
      )
    }
    assert.ok(
      !frame.elements.some(
        element =>
          element.markdownPlaceholder &&
          element.height > 0 &&
          element.bottom > frame.top &&
          element.top < frame.top + frame.height
      ),
      `${name}: the resize exposed a Markdown placeholder: ${JSON.stringify(frame)}`
    )
    // In follow mode composer height may change with width. The actual bottom
    // distance is the anchor, while the last paragraph must remain visible.
    if (pinned)
      assert.ok(
        distanceFromBottom(frame) <= 2,
        `${name}: the active reply lost its bottom pinning: ${JSON.stringify(frame)}`
      )
  }
}

async function markAnchor(control, text, marker) {
  await control.command('markElementWithText', ANCHORS, {
    text,
    value: marker,
    visible: true,
  })
}

async function positionReadingAnchor(control) {
  // The preceding paragraph may currently be outside the mounted Markdown
  // window. Move the real viewport before resolving the semantic anchor.
  await control.command('scrollFromBottomAsUser', SCROLLER_SELECTOR, { value: '800' })
  await control.command('waitFor', ANCHORS, { text: READING })
  await control.command('scrollIntoViewAsUser', ANCHORS, { text: READING, value: 'start' })
  await control.command('waitFor', ANCHORS, { text: READING, visible: true })
  await markAnchor(control, READING, `${MARKER}-reader`)
  const viewport = await getSingleElementMetrics(
    control,
    SCROLLER_SELECTOR,
    'The active reading viewport'
  )
  assert.ok(distanceFromBottom(viewport) > 100, 'The user must be reading above the bottom')
}

async function verifySwitchAfterPlaceholderResize(control, { resultDir, uiTimeoutMs }) {
  const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  const address = debug.workbench?.currentRuntimeTask
  assert.ok(address?.taskId, 'The panel-resize fixture must have a restorable task')
  // Navigate within one existing windowed history row, so the tail can use a
  // measured offscreen placeholder while the reader remains at its earlier text.
  const chunks = `${ASSISTANT_CONTENT_SELECTOR} [data-markdown-window-chunk]`
  const oldWidth = await control.command('getAttribute', LIST, {
    value: 'data-conversation-layout-width',
  })
  assert.ok(Number(oldWidth) > 0, 'The history row must start in a measured column')
  await control.command('scrollIntoViewAsUser', chunks, { text: HISTORY_TAIL, value: 'start' })
  await control.command('waitFor', ANCHORS, { text: HISTORY_TAIL, visible: true })
  await control.command('scrollIntoViewAsUser', chunks, { text: HISTORY_READING, value: 'start' })
  await control.command('waitFor', ANCHORS, { text: HISTORY_READING, visible: true })
  // The Markdown chunk can contain multiple headings. Align the exact text
  // anchor so the reader tracks it instead of the preceding paragraph.
  await control.command('scrollIntoViewAsUser', ANCHORS, { text: HISTORY_READING, value: 'start' })
  const retained = `${LIST} [data-markdown-window-placeholder][data-markdown-placeholder-row-width="${oldWidth}"]`
  await control.command('waitFor', retained, { text: HISTORY_TAIL, timeoutMs: STEP_TIMEOUT })
  const marker = `${MARKER}-history-reader`
  await markAnchor(control, HISTORY_READING, marker)
  const viewport = await getSingleElementMetrics(control, SCROLLER_SELECTOR, 'The history viewport')
  const anchor = await getSingleElementMetrics(
    control,
    `[data-e2e-anchor-id="${marker}"]`,
    'The history reading anchor'
  )
  assert.ok(
    Math.abs(anchor.top - viewport.top) <= 2,
    'The reader must start at the sampled heading'
  )
  await toggleAndSample(control, {
    resultDir,
    name: 'switch-open',
    open: true,
    pinned: false,
    marker,
  })
  const width = await control.command('getAttribute', LIST, {
    value: 'data-conversation-layout-width',
  })
  assert.ok(Number(width) < Number(oldWidth), 'The reopened column must have a different width')
  // The old height must genuinely remain live at the new width. Otherwise a
  // switch would not exercise provisional row measurement restoration at all.
  await control.command('waitFor', retained, { text: HISTORY_TAIL, timeoutMs: STEP_TIMEOUT })
  await verifyConversationSwitchPosition(control, {
    address,
    anchorText: HISTORY_READING,
    name: 'resized-reader',
    pinned: false,
    resultDir,
    uiTimeoutMs,
  })
  await control.command('waitFor', ANCHORS, { text: HISTORY_READING, visible: true })
  assert.equal(
    await control.command('getAttribute', LIST, { value: 'data-conversation-layout-width' }),
    width,
    'The selected task did not restore the resized column'
  )
}

export function createConversationPanelResizeChecks({ resultDir, uiTimeoutMs }) {
  let releaseAppend
  let releaseDone
  const append = new Promise(resolve => {
    releaseAppend = resolve
  })
  const done = new Promise(resolve => {
    releaseDone = resolve
  })
  const cleanup = () => {
    releaseAppend()
    releaseDone()
  }
  return {
    cleanup,
    async handleModelRequest(body, response, id) {
      if (!latestModelInputText(body).includes(PROMPT)) return false
      const stream = streamingEvents(id, COMPLETE)
      response.once('close', cleanup)
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.flushHeaders()
      response.write(sse([...stream.start, ...textDeltaEvents(stream.itemId, PREFIX)]))
      await append
      if (response.destroyed) return true
      response.write(sse(textDeltaEvents(stream.itemId, APPEND, PREFIX.length)))
      await done
      if (response.destroyed) return true
      response.end(
        sse([
          ...textDeltaEvents(stream.itemId, `\n\n${DONE}`, PREFIX.length + APPEND.length),
          ...stream.finish,
        ])
      )
      return true
    },
    async verify(control) {
      const previousSize = JSON.parse(
        await control.command('setMainWindowSize', 'body', {
          value: JSON.stringify({ width: 1600, height: 1200 }),
        })
      )
      let originallyOpen
      const resizeFailures = []
      const check = async options => {
        let passed = true
        try {
          await toggleAndSample(control, { resultDir, ...options })
        } catch (error) {
          resizeFailures.push(error)
          passed = false
        }
        // Retain independent close/read evidence when a transient-frame
        // assertion fails, without mistaking an unsuccessful click for success.
        await control.command('waitFor', `${SHELL}[aria-hidden="${!options.open}"]`, {
          timeoutMs: STEP_TIMEOUT,
        })
        return passed
      }
      try {
        originallyOpen =
          (await control.command('getAttribute', SHELL, { value: 'aria-hidden' })) === 'false'
        if (originallyOpen) await control.command('clickWhenEnabled', TOGGLE)
        await control.command('waitFor', `${SHELL}[aria-hidden="true"]`)
        await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
        await control.command(
          'clickWhenEnabled',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        await control.command('waitFor', ANCHORS, { text: PARTIAL, visible: true })
        await assertStreamActive(control)
        await waitForBottom(control, 'The streaming panel-resize fixture', uiTimeoutMs, 1)
        await markAnchor(control, PARTIAL, MARKER)
        if (!(await check({ name: 'follow-open', open: true, pinned: true }))) {
          await control.command('scrollToBottomAsUser', SCROLLER_SELECTOR)
        }
        await waitForBottom(control, 'The expanded panel-resize fixture', STEP_TIMEOUT, 1)
        await markAnchor(control, PARTIAL, MARKER)
        if (!(await check({ name: 'follow-close', open: false, pinned: true }))) {
          await control.command('scrollToBottomAsUser', SCROLLER_SELECTOR)
        }

        // Release real streamed output between the two geometry checks. Hold the
        // next response boundary so ordinary streaming motion cannot mask a resize.
        releaseAppend()
        await control.command('waitFor', ANCHORS, { text: APPENDED, visible: true })
        await assertStreamActive(control)
        await waitForBottom(control, 'Streaming after closing the panel', uiTimeoutMs, 1)
        await control.command('setConversationFrameProbeEnabled', 'body', { value: 'true' })
        await positionReadingAnchor(control)
        const reader = { marker: `${MARKER}-reader`, pinned: false }
        if (!(await check({ ...reader, name: 'read-open', open: true }))) {
          await positionReadingAnchor(control)
        }
        await check({ ...reader, name: 'read-close', open: false })
        releaseDone()
        await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
        await verifySwitchAfterPlaceholderResize(control, { resultDir, uiTimeoutMs })
        await control.command('press', SCROLLBAR, { key: 'End' })
        await control.command('waitFor', ANCHORS, { text: DONE, visible: true })
      } catch (error) {
        resizeFailures.push(error)
      } finally {
        cleanup()
        await collectFailure(resizeFailures, () =>
          control.command('setConversationFrameProbeEnabled', 'body', { value: 'false' })
        )
        await collectFailure(resizeFailures, async () => {
          if (originallyOpen !== undefined) {
            const open =
              (await control.command('getAttribute', SHELL, { value: 'aria-hidden' })) === 'false'
            if (open !== originallyOpen) await control.command('clickWhenEnabled', TOGGLE)
          }
        })
        await collectFailure(resizeFailures, () =>
          control.command('setMainWindowSize', 'body', { value: JSON.stringify(previousSize) })
        )
      }
      throwFailures(resizeFailures, 'Conversation panel resize was unstable')
    },
  }
}
