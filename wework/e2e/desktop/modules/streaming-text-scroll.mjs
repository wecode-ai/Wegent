import {
  openNewChatWithE2EModel,
  COMPOSER_SELECTOR,
  TIMER_PROMPT,
  waitForNewTaskRow,
  waitForToolDuration,
  ACTIVE_WORKBENCH_SELECTOR,
  processingDurationSeconds,
  PROCESSING_SUMMARY_SELECTOR,
  toolDurationSeconds,
  ASSISTANT_CONTENT_SELECTOR,
  TIMER_COMPLETION,
  waitForRuntimePaneReadyToSend,
  completedToolDuration,
  INITIAL_PROMPT,
  HISTORY_TURNS,
  retainSecondTaskWorkspace,
  ATTACHMENT_FILENAME,
  ATTACHMENT_BASE64,
  PROMPT,
  requestContainsPrompt,
  THINKING_INDICATOR_SELECTOR,
  waitForBottom,
  getSingleElementMetrics,
  assertElementFullyVisible,
  USER_MESSAGE_SELECTOR,
  USER_MESSAGE_E2E_ID,
  USER_MESSAGE_SELECTOR_MARKED,
  SCROLLER_SELECTOR,
  waitForRuntimeAssistantText,
  PARTIAL_TEXT,
  PROCESS_TEXT_SELECTOR,
  MARKER,
  APPEND_MARKER,
  VIEWPORT_ANCHOR_SCOPE_SELECTOR,
  VIEWPORT_ANCHOR_TEXT,
  VIEWPORT_ANCHOR_E2E_ID,
  VIEWPORT_ANCHOR_SELECTOR,
  distanceFromBottom,
  distanceFromTop,
  assertComposerDocked,
  waitForRenderedAppend,
  SCROLL_TO_BOTTOM_BUTTON_SELECTOR,
  SCROLL_BUTTON_APPEND_MARKER,
  PANE_EVICTION_BLANK_COUNT,
  TURN_NAVIGATION_MARKER_SELECTOR,
  STREAMING_TURN_INDEX,
  COMPLETED_SCROLL_ANCHOR_TEXT,
  COMPLETED_SCROLL_ANCHOR_E2E_ID,
  COMPLETED_SCROLL_ANCHOR_SELECTOR,
  assertScrollPositionRemainsStable,
} from './streaming-text-fixture.mjs'
import assert from 'node:assert/strict'
import { sendPromptUntilScenarioRequest } from './shared.mjs'

export function createStreamingScrollChecks({
  modelResponseTimeoutMs,
  uiTimeoutMs,
  capture,
  releaseTimerFinalCompletion,
  requestReceived,
  getTargetRequest,
  releaseStart,
  partialWritten,
  releaseAppend,
  appendWritten,
  releaseScrollButtonAppend,
  scrollButtonAppendWritten,
  releaseResponse,
}) {
  const verifyTimers = async control => {
    await openNewChatWithE2EModel(control, uiTimeoutMs)
    const knownTimerTaskRows = new Set(
      JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
        testId.startsWith('runtime-local-task-row-')
      )
    )
    await control.command('fill', COMPOSER_SELECTOR, { value: TIMER_PROMPT })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    const timerTaskRowTestId = await waitForNewTaskRow(
      control,
      knownTimerTaskRows,
      TIMER_PROMPT,
      uiTimeoutMs
    )
    const toolDurationBeforeSwitch = await waitForToolDuration(control, 3, uiTimeoutMs)
    const processingDurationSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="processing-duration-label"]`
    const runningDurationBeforeSwitch = await control.command('getText', processingDurationSelector)
    assert.match(runningDurationBeforeSwitch, /已处理/, 'The running turn duration was missing')
    const elapsedBeforeSwitch = processingDurationSeconds(runningDurationBeforeSwitch)
    // The turn label refreshes once per second; tool rows refresh every 100 ms.
    assert.ok(elapsedBeforeSwitch >= 2, 'The turn timer did not advance with the running tool')
    const summaryBeforeSwitch = await control.command('getText', PROCESSING_SUMMARY_SELECTOR)
    assert.equal(
      toolDurationSeconds(summaryBeforeSwitch),
      0,
      `The tool summary exposed an aggregate duration: ${summaryBeforeSwitch}`
    )
    await capture(control, 'streaming-text-06-running-tool.png')
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
    await control.command('clickWhenEnabled', `[data-testid="${timerTaskRowTestId}"]`, {
      timeoutMs: uiTimeoutMs,
    })
    const toolDurationAfterSwitch = await waitForToolDuration(control, 1, uiTimeoutMs)
    const runningDurationAfterSwitch = await control.command('getText', processingDurationSelector)
    assert.match(runningDurationAfterSwitch, /已处理/)
    assert.ok(
      processingDurationSeconds(runningDurationAfterSwitch) >= elapsedBeforeSwitch,
      `The turn timer reset after switching tasks: ${runningDurationAfterSwitch}`
    )
    assert.ok(
      toolDurationAfterSwitch >= toolDurationBeforeSwitch,
      `The running tool timer reset from ${toolDurationBeforeSwitch}s to ${toolDurationAfterSwitch}s after switching pages`
    )
    const summaryAfterSwitch = await control.command('getText', PROCESSING_SUMMARY_SELECTOR)
    assert.equal(
      toolDurationSeconds(summaryAfterSwitch),
      0,
      `The restored tool summary exposed an aggregate duration: ${summaryAfterSwitch}`
    )
    await capture(control, 'streaming-text-07-running-tool-restored.png')
    let elapsedDuringFinalText
    try {
      await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
        text: TIMER_COMPLETION,
        timeoutMs: 25_000,
      })
      const finalTextDuration = await control.command('getText', processingDurationSelector)
      assert.match(finalTextDuration, /已处理/, 'The timer stopped when final text arrived')
      await new Promise(resolve => setTimeout(resolve, 2100))
      const advancingDuration = await control.command('getText', processingDurationSelector)
      assert.match(advancingDuration, /已处理/)
      elapsedDuringFinalText = processingDurationSeconds(advancingDuration)
      assert.ok(
        elapsedDuringFinalText > processingDurationSeconds(finalTextDuration),
        `The timer froze during final answer streaming: ${finalTextDuration} -> ${advancingDuration}`
      )
    } finally {
      releaseTimerFinalCompletion()
    }
    await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
    const completedDurationBeforeSwitch = await completedToolDuration(control, uiTimeoutMs)
    const completedProcessingDuration = await control.command('getText', processingDurationSelector)
    assert.match(completedProcessingDuration, /用时/, 'The completed turn duration was missing')
    assert.ok(
      processingDurationSeconds(completedProcessingDuration) >= elapsedDuringFinalText,
      `The turn duration reset on completion: ${completedProcessingDuration}`
    )
    await capture(control, 'streaming-text-08-tool-completed.png')
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
    await control.command('clickWhenEnabled', `[data-testid="${timerTaskRowTestId}"]`, {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: TIMER_COMPLETION,
      stableMs: 750,
      timeoutMs: uiTimeoutMs,
    })
    const completedDurationAfterSwitch = await completedToolDuration(control, uiTimeoutMs)
    assert.equal(
      await control.command('getText', processingDurationSelector),
      completedProcessingDuration,
      'The completed turn duration changed after switching tasks'
    )
    assert.equal(
      completedDurationAfterSwitch,
      completedDurationBeforeSwitch,
      `The completed tool duration changed from ${completedDurationBeforeSwitch}s to ${completedDurationAfterSwitch}s after switching conversations`
    )
    await capture(control, 'streaming-text-09-tool-duration-restored.png')
  }
  const verifyScroll = async control => {
    await openNewChatWithE2EModel(control, uiTimeoutMs)
    const knownTaskRows = new Set(
      JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
        testId.startsWith('runtime-local-task-row-')
      )
    )
    await sendPromptUntilScenarioRequest(
      control,
      COMPOSER_SELECTOR,
      INITIAL_PROMPT,
      'streaming_scroll_initial',
      modelResponseTimeoutMs
    )
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_INITIAL_COMPLETE',
      timeoutMs: uiTimeoutMs,
    })
    await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
    const taskRowTestId = await waitForNewTaskRow(
      control,
      knownTaskRows,
      INITIAL_PROMPT,
      uiTimeoutMs
    )
    for (const historyTurn of HISTORY_TURNS) {
      await control.command('fill', COMPOSER_SELECTOR, { value: historyTurn.prompt })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: historyTurn.completion.split('\n')[0],
        timeoutMs: uiTimeoutMs,
      })
      await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
    }
    await retainSecondTaskWorkspace(control, uiTimeoutMs)
    await capture(control, 'streaming-text-11-ready-to-send.png')
    await control.command('pasteFile', COMPOSER_SELECTOR, {
      filename: ATTACHMENT_FILENAME,
      mimeType: 'image/png',
      value: ATTACHMENT_BASE64,
    })
    await control.command('waitFor', '[data-testid="attachment-badge"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    await Promise.race([
      requestReceived,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('The streaming-text model request was not received')),
          uiTimeoutMs
        )
      ),
    ])
    assert.ok(
      requestContainsPrompt(getTargetRequest()),
      'The real Codex request omitted the test prompt'
    )
    assert.ok(
      JSON.stringify(getTargetRequest()).includes(ATTACHMENT_FILENAME),
      'The real Codex request omitted the streaming attachment'
    )
    await control.command('waitFor', THINKING_INDICATOR_SELECTOR, {
      timeoutMs: uiTimeoutMs,
    })
    const waitingScrollerMetrics = await waitForBottom(
      control,
      'The conversation scroller while waiting for the assistant',
      uiTimeoutMs
    )
    const thinkingIndicatorMetrics = await getSingleElementMetrics(
      control,
      THINKING_INDICATOR_SELECTOR,
      'The thinking indicator after sending'
    )
    assertElementFullyVisible(
      thinkingIndicatorMetrics,
      waitingScrollerMetrics,
      'The thinking indicator after sending'
    )
    await control.command('markElementWithText', USER_MESSAGE_SELECTOR, {
      text: PROMPT,
      value: USER_MESSAGE_E2E_ID,
      timeoutMs: uiTimeoutMs,
    })
    const latestUserMessageMetrics = await getSingleElementMetrics(
      control,
      USER_MESSAGE_SELECTOR_MARKED,
      'The latest user message after sending'
    )
    const scrollerAfterSend = await getSingleElementMetrics(
      control,
      SCROLLER_SELECTOR,
      'The conversation scroller after sending'
    )
    assertElementFullyVisible(
      latestUserMessageMetrics,
      scrollerAfterSend,
      'The latest user message after sending'
    )
    releaseStart()
    await partialWritten
    const runtimeTask = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      .workbench.currentRuntimeTask
    const runtimePartial = await waitForRuntimeAssistantText(
      control,
      {
        deviceId: runtimeTask.deviceId,
        taskId: runtimeTask.taskId,
      },
      PARTIAL_TEXT,
      uiTimeoutMs
    )
    assert.equal(
      runtimePartial,
      PARTIAL_TEXT,
      'The runtime conversation cache lost or reordered streamed text before rendering'
    )
    const immediatelyRenderedPartial = await control.command('getText', PROCESS_TEXT_SELECTOR)
    assert.equal(
      immediatelyRenderedPartial.replace(/\s+/g, ''),
      PARTIAL_TEXT.replace(/\s+/g, ''),
      `The active conversation displayed only ${immediatelyRenderedPartial.length} of ${PARTIAL_TEXT.length} streamed characters`
    )
    await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
      text: MARKER,
      stableMs: 750,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('selectText', PROCESS_TEXT_SELECTOR, { value: MARKER })
    assert.notEqual(
      await control.command('getActiveElementTestId', 'body'),
      'chat-message-input',
      'Selecting response text must release the previous composer focus'
    )
    await control.command('waitFor', '[data-testid="message-selection-actions"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="add-selection-to-conversation-button"]')
    assert.ok(
      (await control.command('getValue', COMPOSER_SELECTOR)).includes(MARKER),
      'Adding selected process text did not insert it into the running task composer'
    )
    await control.command('fill', COMPOSER_SELECTOR, { value: '' })
    await waitForBottom(
      control,
      'The conversation scroller while the assistant response starts',
      uiTimeoutMs
    )
    const streamingSnapshot = JSON.parse(
      await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
    )
    assert.ok(
      streamingSnapshot.text.includes(MARKER),
      'The assistant text after the streaming tool call lost its prefix'
    )
    assert.ok(
      streamingSnapshot.testIds.includes('process-text-block'),
      'The phase-less streaming response was not rendered as process content'
    )
    assert.equal(
      (await control.command('getText', PROCESS_TEXT_SELECTOR)).replace(/\s+/g, ''),
      PARTIAL_TEXT.replace(/\s+/g, ''),
      'The streaming process text duplicated or dropped response deltas'
    )
    assert.ok(
      !streamingSnapshot.text.includes(APPEND_MARKER),
      'The later assistant delta was visible before the runtime released it'
    )
    await control.command('waitFor', VIEWPORT_ANCHOR_SCOPE_SELECTOR, {
      text: VIEWPORT_ANCHOR_TEXT,
      stableMs: 750,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('markElementWithText', VIEWPORT_ANCHOR_SCOPE_SELECTOR, {
      text: VIEWPORT_ANCHOR_TEXT,
      value: VIEWPORT_ANCHOR_E2E_ID,
      timeoutMs: uiTimeoutMs,
    })
    assert.equal(
      await control.command('getText', VIEWPORT_ANCHOR_SELECTOR),
      VIEWPORT_ANCHOR_TEXT,
      'The viewport anchor paragraph was not rendered at the expected position'
    )
    await control.command('focusMainWindow', 'body')
    await control.command('scrollFromBottomAsUser', SCROLLER_SELECTOR, { value: '160' })
    const userScrollPosition = await getSingleElementMetrics(
      control,
      SCROLLER_SELECTOR,
      'The streaming conversation immediately after the user scrolled upward'
    )
    assert.ok(
      distanceFromBottom(userScrollPosition) > 8,
      'The simulated user scroll did not move the streaming conversation away from the bottom'
    )
    await new Promise(resolve => setTimeout(resolve, 750))
    const stableUserScrollPosition = await getSingleElementMetrics(
      control,
      SCROLLER_SELECTOR,
      'The streaming conversation after pending bottom restores had time to run'
    )
    assert.ok(
      Math.abs(distanceFromTop(stableUserScrollPosition) - distanceFromTop(userScrollPosition)) <=
        8,
      `The streaming conversation jumped from ${distanceFromTop(userScrollPosition)}px to ${distanceFromTop(stableUserScrollPosition)}px from the content top after the user scrolled upward`
    )
    await assertComposerDocked(
      control,
      stableUserScrollPosition,
      'The composer after the user scrolled the streaming conversation'
    )

    await new Promise(resolve => setTimeout(resolve, 250))
    const scrollerBeforeAppend = await getSingleElementMetrics(
      control,
      SCROLLER_SELECTOR,
      'The streaming conversation scroller before later content'
    )
    assert.ok(
      distanceFromBottom(scrollerBeforeAppend) > 8,
      'The simulated user scroll did not move the streaming conversation away from the bottom'
    )
    let anchorBeforeAppend = await getSingleElementMetrics(
      control,
      VIEWPORT_ANCHOR_SELECTOR,
      'The viewport anchor before later content'
    )
    assert.ok(
      anchorBeforeAppend.top >= scrollerBeforeAppend.top &&
        anchorBeforeAppend.bottom <= scrollerBeforeAppend.bottom,
      `The viewport anchor was not visible after the user scroll (top=${anchorBeforeAppend.top}px, bottom=${anchorBeforeAppend.bottom}px)`
    )
    // Small consecutive wheel steps must move the same text by the requested pixels, including
    // after virtual measurements settle. Return to the starting position before testing append.
    const anchorStartTop = anchorBeforeAppend.top
    for (const delta of [12, 24, 36, 0]) {
      await control.command('scrollFromBottomAsUser', SCROLLER_SELECTOR, {
        value: String(distanceFromBottom(scrollerBeforeAppend) + delta),
      })
      await control.command('waitFor', VIEWPORT_ANCHOR_SCOPE_SELECTOR, {
        text: VIEWPORT_ANCHOR_TEXT,
        stableMs: 200,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('markElementWithText', VIEWPORT_ANCHOR_SCOPE_SELECTOR, {
        text: VIEWPORT_ANCHOR_TEXT,
        value: VIEWPORT_ANCHOR_E2E_ID,
      })
      anchorBeforeAppend = await getSingleElementMetrics(
        control,
        VIEWPORT_ANCHOR_SELECTOR,
        `The viewport anchor after a ${delta}px reading offset`
      )
      assert.ok(
        Math.abs(anchorBeforeAppend.top - anchorStartTop - delta) <= 8,
        `The reading position bounced: expected ${anchorStartTop + delta}px, got ${anchorBeforeAppend.top}px`
      )
    }
    await capture(control, 'streaming-text-12-user-scrolled-up.png')

    const previousContentLength = (await control.command('getText', PROCESS_TEXT_SELECTOR)).length
    assert.ok(
      previousContentLength > 0,
      'The streaming response disappeared before the later content arrived'
    )
    await control.command('startScrollStabilitySampling', VIEWPORT_ANCHOR_SCOPE_SELECTOR, {
      value: JSON.stringify({
        anchorText: VIEWPORT_ANCHOR_TEXT,
        durationMs: 2_000,
        scrollerSelector: SCROLLER_SELECTOR,
      }),
      timeoutMs: 6_000,
    })
    releaseAppend()
    await appendWritten
    let stabilitySamples
    const stabilityDeadline = Date.now() + 6_000
    while (Date.now() < stabilityDeadline) {
      stabilitySamples = JSON.parse(
        await control.command('getScrollStabilitySample', VIEWPORT_ANCHOR_SCOPE_SELECTOR)
      )
      if (stabilitySamples.done) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(
      stabilitySamples?.done,
      `The streaming scroll stability sampler did not finish: ${JSON.stringify({
        frames: stabilitySamples?.frames.length ?? 0,
        missingFrames: stabilitySamples?.missingFrames ?? 0,
        scrollEvents: stabilitySamples?.scrollEvents.length ?? 0,
      })}`
    )
    assert.ok(
      stabilitySamples.frames.length >= 12,
      `The WebView captured only ${stabilitySamples.frames.length} streaming stability samples`
    )
    assert.equal(
      stabilitySamples.missingFrames,
      0,
      'The user-selected text disappeared while the streaming response rerendered'
    )
    const anchorTops = stabilitySamples.frames.map(sample => sample.anchorTop)
    const anchorRange = Math.max(...anchorTops) - Math.min(...anchorTops)
    const effectiveScrollEvents = stabilitySamples.scrollEvents.filter(
      sample => Math.abs(distanceFromTop(sample) - distanceFromTop(scrollerBeforeAppend)) >= 0.5
    )
    const scrollDirections = effectiveScrollEvents
      .slice(1)
      .map((sample, index) =>
        Math.abs(distanceFromTop(sample) - distanceFromTop(effectiveScrollEvents[index])) < 0.5
          ? 0
          : Math.sign(distanceFromTop(sample) - distanceFromTop(effectiveScrollEvents[index]))
      )
      .filter(direction => direction !== 0)
    const directionReversals = scrollDirections.filter(
      (direction, index) => index > 0 && direction !== scrollDirections[index - 1]
    ).length
    assert.ok(
      anchorRange <= 8 && directionReversals === 0 && effectiveScrollEvents.length === 0,
      `The user-selected text jittered while chunks streamed: ${JSON.stringify({
        anchorRange,
        directionReversals,
        effectiveScrollEvents,
        stabilitySamples,
      })}`
    )
    const scrollerAfterAppend = await waitForRenderedAppend(
      control,
      previousContentLength,
      uiTimeoutMs
    )
    const anchorAfterAppend = await getSingleElementMetrics(
      control,
      VIEWPORT_ANCHOR_SELECTOR,
      'The viewport anchor after later content'
    )
    assert.ok(
      Math.abs(anchorAfterAppend.top - anchorBeforeAppend.top) <= 8,
      `The user-selected streaming text moved from ${anchorBeforeAppend.top}px to ${anchorAfterAppend.top}px while later content arrived`
    )
    assert.ok(
      Math.abs(distanceFromTop(scrollerAfterAppend) - distanceFromTop(scrollerBeforeAppend)) <= 8,
      `The paused streaming scroller moved from ${distanceFromTop(scrollerBeforeAppend)}px to ${distanceFromTop(scrollerAfterAppend)}px from the content top`
    )
    await assertComposerDocked(
      control,
      scrollerAfterAppend,
      'The composer after streamed content changed the virtualized conversation height'
    )
    await capture(control, 'streaming-text-13-anchor-stable-after-append.png')

    await control.command('waitFor', SCROLL_TO_BOTTOM_BUTTON_SELECTOR, {
      timeoutMs: uiTimeoutMs,
    })
    releaseScrollButtonAppend()
    await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
      text: SCROLL_BUTTON_APPEND_MARKER,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('pointerDown', SCROLL_TO_BOTTOM_BUTTON_SELECTOR)
    await control.command('click', SCROLL_TO_BOTTOM_BUTTON_SELECTOR)
    // A transcript click during follow must not classify subsequent spring steps as reader input.
    await control.command('pointerClick', SCROLLER_SELECTOR)
    await scrollButtonAppendWritten
    await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
      text: SCROLL_BUTTON_APPEND_MARKER,
      stableMs: 750,
      timeoutMs: uiTimeoutMs,
    })
    const pinnedBeforeSwitch = await waitForBottom(
      control,
      'The growing streaming conversation after clicking the scroll-to-bottom button',
      5_000
    )
    await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
      text: APPEND_MARKER,
      stableMs: 750,
      timeoutMs: uiTimeoutMs,
    })
    assert.ok(
      distanceFromBottom(pinnedBeforeSwitch) <= 8,
      `The scroll-to-bottom button left the growing streaming conversation ${distanceFromBottom(pinnedBeforeSwitch)}px from the bottom`
    )
    // Regression: the bottom pin must survive past the previous fixed release window so a
    // response that keeps growing cannot leave the user staring at the middle of the chat.
    await new Promise(resolve => setTimeout(resolve, 1_200))
    const pinnedAfterReleaseWindow = await getSingleElementMetrics(
      control,
      SCROLLER_SELECTOR,
      'The growing streaming conversation after the bottom release window'
    )
    assert.ok(
      distanceFromBottom(pinnedAfterReleaseWindow) <= 8,
      `The jump-to-bottom pin was dropped after the release window, leaving the conversation ${distanceFromBottom(pinnedAfterReleaseWindow)}px from the bottom`
    )
    await capture(control, 'streaming-text-14-scroll-button-followed-layout-growth.png')
    await new Promise(resolve => setTimeout(resolve, 250))
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
    // Capture the first mounted history frame, before waitForBottom can hide an
    // erroneous animation from the middle of an already-streaming conversation.
    await control.command('startScrollStabilitySampling', PROCESS_TEXT_SELECTOR, {
      value: JSON.stringify({
        anchorText: MARKER,
        durationMs: uiTimeoutMs,
        scrollerSelector: SCROLLER_SELECTOR,
      }),
    })
    await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
      text: MARKER,
      stableMs: 750,
      timeoutMs: uiTimeoutMs,
    })
    const pinnedAfterSwitch = await waitForBottom(
      control,
      'The bottom-pinned streaming conversation after switching back',
      5_000
    )
    assert.ok(
      distanceFromBottom(pinnedAfterSwitch) <= 8,
      `The bottom-pinned streaming conversation reopened ${distanceFromBottom(pinnedAfterSwitch)}px from the bottom`
    )
    const switchFrames = JSON.parse(
      await control.command('stopScrollStabilitySampling', PROCESS_TEXT_SELECTOR)
    ).frames
    assert.ok(switchFrames.length > 0, 'The switch did not capture any mounted streaming history')
    assert.ok(
      switchFrames.every(frame => distanceFromBottom(frame) <= 8),
      `Opening existing streaming history animated from the middle: ${JSON.stringify(switchFrames)}`
    )
    await assertComposerDocked(
      control,
      pinnedAfterSwitch,
      'The composer after reopening the long virtualized conversation'
    )
    await capture(control, 'streaming-text-14-bottom-restored-after-task-switch.png')

    for (let index = 0; index < PANE_EVICTION_BLANK_COUNT; index += 1) {
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
    }
    await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
      text: MARKER,
      stableMs: 750,
      timeoutMs: uiTimeoutMs,
    })
    const remountedScroller = await waitForBottom(
      control,
      'The remounted long virtualized conversation',
      uiTimeoutMs
    )
    await assertComposerDocked(
      control,
      remountedScroller,
      'The composer after remounting the long virtualized conversation'
    )
    await capture(control, 'streaming-text-15-composer-docked-after-pane-remount.png')
    assert.equal(
      Number(await control.command('getElementCount', TURN_NAVIGATION_MARKER_SELECTOR)),
      HISTORY_TURNS.length + 2,
      'The remounted running conversation lost or duplicated earlier user turns'
    )
    await control.command('hover', `${TURN_NAVIGATION_MARKER_SELECTOR}[data-turn-index="0"]`)
    const initialTurnPreview = await control.command(
      'getText',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-preview"][data-turn-index="0"]`
    )
    assert.ok(
      initialTurnPreview.includes(INITIAL_PROMPT),
      'The remounted running conversation lost the previous user question'
    )
    assert.ok(
      initialTurnPreview.includes('WEWORK_DESKTOP_E2E_STREAMING_TEXT_INITIAL_COMPLETE'),
      'The remounted running conversation lost the previous assistant answer'
    )
    await control.command(
      'hover',
      `${TURN_NAVIGATION_MARKER_SELECTOR}[data-turn-index="${STREAMING_TURN_INDEX}"]`
    )
    const streamingTurnPreview = await control.command(
      'getText',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-preview"][data-turn-index="${STREAMING_TURN_INDEX}"]`
    )
    assert.ok(
      streamingTurnPreview.includes('WEWORK_DESKTOP_E2E_STREAMING_TEXT'),
      'The streaming turn preview did not show the visible user input'
    )
    assert.ok(
      !streamingTurnPreview.includes('Files mentioned by the user'),
      'The streaming turn preview exposed the internal attachment wrapper'
    )
    assert.ok(
      !streamingTurnPreview.includes('application_context'),
      'The streaming turn preview exposed injected application context'
    )
    await capture(control, 'streaming-text-16-thinking-below-partial-response.png')

    releaseResponse()
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
      { timeoutMs: uiTimeoutMs }
    )
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: MARKER,
      timeoutMs: uiTimeoutMs,
    })

    await control.command('scrollFromBottomAsUser', SCROLLER_SELECTOR, { value: '160' })
    const completedUserScrollPosition = await getSingleElementMetrics(
      control,
      SCROLLER_SELECTOR,
      'The completed conversation immediately after the user scrolled upward'
    )
    assert.ok(
      distanceFromBottom(completedUserScrollPosition) > 8,
      'The user scroll did not move the completed conversation away from the bottom'
    )
    await control.command('markElementWithText', `${ASSISTANT_CONTENT_SELECTOR} p`, {
      text: COMPLETED_SCROLL_ANCHOR_TEXT,
      value: COMPLETED_SCROLL_ANCHOR_E2E_ID,
      timeoutMs: uiTimeoutMs,
    })
    const completedScrollAnchorPosition = await getSingleElementMetrics(
      control,
      COMPLETED_SCROLL_ANCHOR_SELECTOR,
      'The visible paragraph after the completed conversation scrolled upward'
    )
    await assertScrollPositionRemainsStable(
      control,
      completedUserScrollPosition,
      COMPLETED_SCROLL_ANCHOR_SELECTOR,
      completedScrollAnchorPosition,
      'The completed conversation while delayed bottom-follow work could still run',
      uiTimeoutMs
    )
    await capture(control, 'streaming-text-18-completed-user-scroll-stable.png')

    // Regression: a small upward scroll that stays within the bottom tolerance must keep
    // its up-scroll pause so the follow engine cannot snap the viewport straight back to
    // the bottom (the reported "cannot scroll up while the assistant replies" issue).
    await control.command('scrollToBottomAsUser', SCROLLER_SELECTOR)
    await waitForBottom(
      control,
      'The completed conversation before the small up-scroll regression',
      uiTimeoutMs
    )
    await control.command('scrollFromBottomAsUser', SCROLLER_SELECTOR, { value: '3' })
    const smallUpScrollPosition = await getSingleElementMetrics(
      control,
      SCROLLER_SELECTOR,
      'The completed conversation immediately after a small up-scroll'
    )
    assert.ok(
      distanceFromBottom(smallUpScrollPosition) > 0,
      'The small up-scroll did not move the completed conversation away from the very bottom'
    )
    const smallUpScrollDeadline = Date.now() + 2_000
    while (Date.now() < smallUpScrollDeadline) {
      const current = await getSingleElementMetrics(
        control,
        SCROLLER_SELECTOR,
        'The completed conversation while pending bottom-follow work could run'
      )
      assert.ok(
        distanceFromBottom(current) > 0,
        `The small up-scroll was snapped straight back to the bottom (paused follow cleared the up-scroll intent; now ${distanceFromBottom(current)}px from the bottom)`
      )
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    // Regression: sweeping upward through the history must keep moving the reader away from
    // the bottom. Re-measured rows used to drag the viewport back down, which the user saw
    // as small bounces while reading and as being yanked back to the very bottom.
    const sweepStart = await getSingleElementMetrics(
      control,
      SCROLLER_SELECTOR,
      'The completed conversation before the fast upward sweep'
    )
    const sweepMaximum = Math.max(
      1,
      sweepStart.scrollHeight - sweepStart.clientHeight,
      distanceFromBottom(sweepStart)
    )
    let sweepDistanceFromBottom = distanceFromBottom(sweepStart)
    let previousSweepFraction = 0
    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      await control.command('scrollFromBottomAsUser', SCROLLER_SELECTOR, {
        value: String(Math.round(sweepMaximum * fraction)),
      })
      await new Promise(resolve => setTimeout(resolve, 200))
      const sweepStep = await getSingleElementMetrics(
        control,
        SCROLLER_SELECTOR,
        `The completed conversation after fast upward sweep step ${fraction}`
      )
      const stepDistanceFromBottom = distanceFromBottom(sweepStep)
      // Re-measured rows above the viewport keep the reader's text still, so the distance from the
      // bottom legitimately lands short of the requested position. What must hold is that the sweep
      // moves the reader further up the history instead of leaving the viewport near the bottom.
      const requestedStepDistance = Math.round(sweepMaximum * (fraction - previousSweepFraction))
      assert.ok(
        stepDistanceFromBottom >= sweepDistanceFromBottom + requestedStepDistance / 2,
        `The fast upward sweep did not advance (${Math.round(sweepDistanceFromBottom)}px -> ${Math.round(stepDistanceFromBottom)}px from the bottom)`
      )
      sweepDistanceFromBottom = stepDistanceFromBottom
      previousSweepFraction = fraction
    }
    await capture(control, 'streaming-text-19-fast-up-scroll-stable.png')
    assert.ok(
      sweepDistanceFromBottom > 0,
      'The fast upward sweep never left the bottom of the completed conversation'
    )

    await control.command('scrollToBottomAsUser', SCROLLER_SELECTOR)
    await waitForBottom(
      control,
      'The completed conversation after clearing the small up-scroll regression',
      uiTimeoutMs
    )
    const completedSnapshot = JSON.parse(
      await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
    )
    assert.ok(
      completedSnapshot.text.includes(MARKER),
      'The completed response lost its streamed text'
    )
    assert.ok(
      completedSnapshot.testIds.includes('assistant-message-content'),
      'The completed response was not retained as assistant content'
    )
    assert.ok(
      !completedSnapshot.testIds.includes('thinking-indicator'),
      'The thinking indicator remained after completion'
    )
    assert.ok(
      !completedSnapshot.testIds.includes('pause-response-button'),
      'The pause button remained after completion'
    )
    await capture(control, 'streaming-text-17-response-completed.png')
  }
  return { verifyTimers, verifyScroll }
}
