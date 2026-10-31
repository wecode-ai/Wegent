import { sendOrderFollowUp } from './streaming-text-fixture.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  openNewChatWithE2EModel,
  COMPOSER_SELECTOR,
  LONG_CODE_PROMPT,
  ASSISTANT_CONTENT_SELECTOR,
  LONG_CODE_STREAM_MARKER,
  LONG_CODE_SCROLL_SELECTOR,
  LONG_CODE_E2E_ID,
  THINKING_INDICATOR_SELECTOR,
  LONG_CODE_MARKER,
  waitForRuntimePaneReadyToSend,
  LONG_CODE_MARKED_SELECTOR,
  waitForBottom,
  SCROLLER_SELECTOR,
  WINDOWS_LINK_PROMPT,
  ASSISTANT_MARKDOWN_LINK_SELECTOR,
  WINDOWS_LINK_LABEL,
  ORDER_STOP_PROMPT,
  waitForNewTaskRow,
  ASSISTANT_MESSAGE_SELECTOR,
  ORDER_STOP_PARTIAL,
  ORDER_FOLLOW_UP_COUNT,
  processingDurationSeconds,
  PANE_EVICTION_BLANK_COUNT,
  ORDER_COMPLETION_PREFIX,
  SUBAGENT_PROMPT,
  SUBAGENT_CHILD_PARTIAL,
  SUBAGENT_CHILD_TOOL_MARKER,
  SUBAGENT_CHILD_REASONING,
  SUBAGENT_CHILD_COMMENTARY,
  SUBAGENT_CHILD_FINAL,
  SUBAGENT_PARENT_COMPLETION,
  LEGACY_CONVERSATION_PROMPT,
  LEGACY_CONVERSATION_COMPLETION,
  PHASE_FLIP_PROMPT,
  PHASE_FLIP_TEXT,
  LEGACY_TRANSCRIPT_ITEM_ID,
  PROCESS_TEXT_SELECTOR,
  TOOL_REGRESSION_PROMPT,
  TOOL_PREAMBLE,
  TOOL_THINKING_INDICATOR_SELECTOR,
  REASONING_PREVIEW,
  TOOL_COMPLETION,
  REASONING_SUMMARY,
  assertComposerDocked,
  TOOL_DETAIL_PERSISTENCE_PROMPT,
  TOOL_DETAIL_PERSISTENCE_CALL_ID,
  TOOL_DETAIL_PERSISTENCE_OUTPUT,
  TOOL_DETAIL_PERSISTENCE_COMPLETION,
} from './streaming-text-fixture.mjs'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function createStreamingToolChecks({
  uiTimeoutMs,
  releaseLongCodeStream,
  resultDir,
  capture,
  modelResponseTimeoutMs,
  captureSubagent,
  subagentToolRenderTimeoutMs,
  subagentPartialWritten,
  releaseSubagentCompletion,
  releasePhaseFlipCompletion,
  toolFollowUpReceived,
  releaseToolCompletion,
  releaseToolFinalCompletion,
  toolFinalTextStarted,
  toolDetailPersistenceFollowUpReceived,
  releaseToolDetailPersistenceFinalText,
  releaseToolDetailPersistenceCompletion,
  toolDetailPersistenceFinalTextStarted,
}) {
  const verifyLongCodeTerminalBurst = async control => {
    await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
    await openNewChatWithE2EModel(control, uiTimeoutMs)
    await control.command('fill', COMPOSER_SELECTOR, { value: LONG_CODE_PROMPT })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: LONG_CODE_STREAM_MARKER,
      stableMs: 250,
      timeoutMs: modelResponseTimeoutMs,
    })
    await control.command('waitFor', LONG_CODE_SCROLL_SELECTOR, {
      stableMs: 500,
      timeoutMs: modelResponseTimeoutMs,
    })
    const streamingSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    await control.command('markElementWithText', `${LONG_CODE_SCROLL_SELECTOR} code`, {
      text: LONG_CODE_STREAM_MARKER,
      value: LONG_CODE_E2E_ID,
      timeoutMs: uiTimeoutMs,
    })
    const streamingClass = await control.command('getAttribute', LONG_CODE_SCROLL_SELECTOR, {
      value: 'class',
    })
    assert.match(
      streamingClass,
      /\bscrollbar-none\b/,
      'The native horizontal scrollbar remained visible while long code streamed'
    )
    assert.equal(
      Number(await control.command('getElementCount', THINKING_INDICATOR_SELECTOR)),
      0,
      'The generic thinking indicator remained after long-code output became visible'
    )
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="final-processing-toggle"]`
        )
      ),
      0,
      'The processing timeline completed while final assistant text was still streaming'
    )

    releaseLongCodeStream()
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: LONG_CODE_MARKER,
      stableMs: 500,
      timeoutMs: modelResponseTimeoutMs,
    })
    await waitForRuntimePaneReadyToSend(control, modelResponseTimeoutMs)
    const completedSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    await writeFile(
      join(resultDir, 'streaming-text-long-code-identity.json'),
      JSON.stringify(
        {
          streaming: streamingSnapshot.pane?.messageSummary,
          completed: completedSnapshot.pane?.messageSummary,
        },
        null,
        2
      ) + '\n',
      'utf8'
    )
    assert.equal(
      Number(await control.command('getElementCount', LONG_CODE_MARKED_SELECTOR)),
      1,
      'The long code DOM was replaced while more lines streamed'
    )

    let syntaxHighlighted = 'false'
    const highlightDeadline = Date.now() + uiTimeoutMs
    while (Date.now() < highlightDeadline) {
      syntaxHighlighted = await control.command('getAttribute', LONG_CODE_SCROLL_SELECTOR, {
        value: 'data-syntax-highlighted',
      })
      if (syntaxHighlighted === 'true') break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(
      syntaxHighlighted,
      'true',
      'The completed long code block did not receive syntax highlighting'
    )
    assert.ok(
      Number(
        await control.command('getElementCount', `${LONG_CODE_SCROLL_SELECTOR} .hljs-keyword`)
      ) > 0,
      'The completed long code block did not render highlighted keyword nodes'
    )
    const completedClass = await control.command('getAttribute', LONG_CODE_SCROLL_SELECTOR, {
      value: 'class',
    })
    assert.doesNotMatch(
      completedClass,
      /\bscrollbar-none\b/,
      'The completed long code block kept its horizontal scrollbar hidden'
    )
    assert.match(
      completedClass,
      /\bscrollbar-soft\b/,
      'The completed long code block did not restore its horizontal scrollbar'
    )
    await waitForBottom(control, 'The terminal-burst long-code conversation', uiTimeoutMs)
    const rapidScrollSamples = JSON.parse(
      await control.command('sampleRapidMarkdownWindowing', SCROLLER_SELECTOR, {
        value: JSON.stringify({
          contentSelector: '[data-markdown-window-chunk]',
          framesPerRatio: 4,
          ratios: [0.75, 0.5, 0.25],
        }),
      })
    )
    await writeFile(
      join(resultDir, 'streaming-text-rapid-markdown-windowing.json'),
      JSON.stringify(rapidScrollSamples, null, 2) + '\n',
      'utf8'
    )
    assert.equal(rapidScrollSamples.frameCount, 12, 'Rapid Markdown scrolling missed frame samples')
    assert.ok(
      rapidScrollSamples.initial.placeholderChunkCount > 0,
      'The completed transcript eagerly mounted every distant Markdown chunk'
    )
    assert.equal(
      rapidScrollSamples.samples.every(sample => sample.visiblePlaceholderCount === 0),
      true,
      `Rapid scrolling painted a Markdown placeholder before rich rendering: ${JSON.stringify(rapidScrollSamples)}`
    )
    assert.equal(
      rapidScrollSamples.samples.every(
        sample => sample.visibleRichChunkCount > 0 && sample.hasVisibleText
      ),
      true,
      `Rapid scrolling exposed an empty Markdown viewport: ${JSON.stringify(rapidScrollSamples)}`
    )
    assert.ok(
      rapidScrollSamples.maxVisibleChunkHeightDelta <= 1,
      `Completed Markdown changed height between visible frames: ${JSON.stringify(rapidScrollSamples)}`
    )
    await capture(control, 'streaming-text-00-long-code-terminal-burst.png')
  }

  const verifyWindowsDriveLinkRendering = async control => {
    await openNewChatWithE2EModel(control, uiTimeoutMs)
    await control.command('fill', COMPOSER_SELECTOR, { value: WINDOWS_LINK_PROMPT })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    await control.command('waitFor', ASSISTANT_MARKDOWN_LINK_SELECTOR, {
      text: WINDOWS_LINK_LABEL,
      timeoutMs: uiTimeoutMs,
    })
    const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
    assert.ok(
      !snapshot.text.includes('[blocked]'),
      'The Windows drive-letter markdown link was rendered as blocked text'
    )
    await capture(control, 'streaming-text-00-windows-drive-link.png')
  }

  const verifyStoppedTurnOrder = async control => {
    await openNewChatWithE2EModel(control, uiTimeoutMs)
    const knownOrderTaskRows = new Set(
      JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
        testId.startsWith('runtime-local-task-row-')
      )
    )
    await control.command('fill', COMPOSER_SELECTOR, { value: ORDER_STOP_PROMPT })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    const orderTaskRowTestId = await waitForNewTaskRow(
      control,
      knownOrderTaskRows,
      ORDER_STOP_PROMPT,
      uiTimeoutMs
    )
    await control.command('waitFor', '[data-testid="pause-response-button"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', ASSISTANT_MESSAGE_SELECTOR, {
      text: ORDER_STOP_PARTIAL,
      stableMs: 500,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="pause-response-button"]')
    await control.command('waitFor', '[data-testid="assistant-stopped-notice"]', {
      timeoutMs: uiTimeoutMs,
    })
    await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
    for (let index = 1; index <= ORDER_FOLLOW_UP_COUNT; index += 1) {
      await sendOrderFollowUp(control, index, uiTimeoutMs, modelResponseTimeoutMs)
    }
    await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
    const durationSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="processing-duration-label"]`
    const completedDuration = await control.command('getText', durationSelector)
    assert.match(completedDuration, /用时/)
    assert.ok(
      processingDurationSeconds(completedDuration) >= 2,
      `The turn following a stopped turn lost its elapsed time: ${completedDuration}`
    )
    for (let index = 0; index < PANE_EVICTION_BLANK_COUNT; index += 1) {
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
    }
    await control.command('clickWhenEnabled', `[data-testid="${orderTaskRowTestId}"]`, {
      timeoutMs: uiTimeoutMs,
    })
    const latestOrderCompletion = `${ORDER_COMPLETION_PREFIX}_${ORDER_FOLLOW_UP_COUNT}`
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: latestOrderCompletion,
      stableMs: 750,
      timeoutMs: uiTimeoutMs,
    })
    assert.equal(
      Number(await control.command('getElementCount', '[data-testid="assistant-stopped-notice"]')),
      0,
      'The latest transcript position remained on the older stopped turn'
    )
    const restoredDuration = await control.command('getText', durationSelector)
    assert.match(restoredDuration, /用时/)
    assert.ok(
      processingDurationSeconds(restoredDuration) >= 2,
      `The resumed turn duration reset after transcript restoration: ${restoredDuration}`
    )
    await capture(control, 'streaming-text-17-stopped-turn-order-restored.png')
  }

  const verifySubagentStreamingPanel = async control => {
    const previousSize = JSON.parse(
      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 1600, height: 900 }),
      })
    )
    await openNewChatWithE2EModel(control, uiTimeoutMs)

    await control.command('fill', COMPOSER_SELECTOR, { value: SUBAGENT_PROMPT })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    await control.command('waitFor', '[data-testid="subagent-activity-chip"]', {
      timeoutMs: uiTimeoutMs,
    })
    assert.equal(
      (await control.command('getText', ASSISTANT_CONTENT_SELECTOR)).includes(
        SUBAGENT_CHILD_PARTIAL
      ),
      false,
      'The child agent stream leaked into the root conversation'
    )
    await captureSubagent(control, 'streaming-text-subagent-01-inline-activity.png')
    // The chip lives in the live processing preview, which re-mounts while the
    // transcript re-projects, so give the click the same retry budget as the
    // wait instead of clicking a single DOM snapshot.
    await control.command('clickWhenEnabled', '[data-testid="subagent-activity-chip"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', '[data-testid="subagent-conversation-panel"]', {
      timeoutMs: uiTimeoutMs,
    })
    assert.equal(
      await control.command('getAttribute', '[data-testid="right-workspace-subagents-tab"]', {
        value: 'aria-selected',
      }),
      'true',
      'The subagent conversation was not opened inside the active right workspace tab'
    )
    await control.command('waitFor', '[data-testid="subagent-conversation-scroll"]', {
      text: SUBAGENT_CHILD_TOOL_MARKER,
      timeoutMs: subagentToolRenderTimeoutMs,
    })
    for (const text of [SUBAGENT_CHILD_REASONING, SUBAGENT_CHILD_COMMENTARY]) {
      await control.command('waitFor', '[data-testid="subagent-conversation-scroll"]', {
        text,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        (await control.command('getText', ASSISTANT_CONTENT_SELECTOR)).includes(text),
        false,
        'The child process content leaked into the root conversation'
      )
    }
    await control.command(
      'waitFor',
      '[data-testid="subagent-conversation-scroll"] [data-testid="tool-block-duration"]',
      {
        timeoutMs: subagentToolRenderTimeoutMs,
      }
    )
    assert.equal(
      (await control.command('getText', ASSISTANT_CONTENT_SELECTOR)).includes(
        SUBAGENT_CHILD_TOOL_MARKER
      ),
      false,
      'The running child tool leaked into the root conversation'
    )
    await subagentPartialWritten
    await control.command('waitFor', '[data-testid="subagent-conversation-scroll"]', {
      text: SUBAGENT_CHILD_TOOL_MARKER,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', '[data-testid="subagent-conversation-scroll"]', {
      text: SUBAGENT_CHILD_PARTIAL,
      timeoutMs: uiTimeoutMs,
    })
    assert.equal(
      (await control.command('getText', ASSISTANT_CONTENT_SELECTOR)).includes(
        SUBAGENT_CHILD_PARTIAL
      ),
      false,
      'The rendered child agent stream leaked into the root conversation'
    )
    assert.equal(
      (await control.command('getText', ASSISTANT_CONTENT_SELECTOR)).includes(
        SUBAGENT_CHILD_TOOL_MARKER
      ),
      false,
      'The completed child tool leaked into the root conversation'
    )
    await captureSubagent(control, 'streaming-text-subagent-02-streaming-conversation.png')
    releaseSubagentCompletion()
    await control.command('waitFor', '[data-testid="subagent-conversation-scroll"]', {
      text: SUBAGENT_CHILD_FINAL,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: SUBAGENT_PARENT_COMPLETION,
      timeoutMs: uiTimeoutMs,
    })
    for (const text of [SUBAGENT_CHILD_REASONING, SUBAGENT_CHILD_COMMENTARY]) {
      await control.command('waitFor', '[data-testid="subagent-conversation-scroll"]', {
        text,
        timeoutMs: uiTimeoutMs,
      })
    }
    assert.equal(
      (await control.command('getText', '[data-testid="subagent-conversation-scroll"]')).includes(
        SUBAGENT_PARENT_COMPLETION
      ),
      false,
      'The root final answer was loaded into the child conversation'
    )
    await captureSubagent(control, 'streaming-text-subagent-03-completed-conversation.png')

    await control.command('click', '[data-testid="subagent-conversation-back"]')
    await control.command('waitFor', '[data-testid="subagent-overview-panel"]', {
      timeoutMs: uiTimeoutMs,
    })
    assert.equal(
      await control.command('getAttribute', '[data-testid="right-workspace-subagents-tab"]', {
        value: 'aria-selected',
      }),
      'true',
      'The subagent overview lost its right workspace tab'
    )
    assert.equal(
      Number(await control.command('getElementCount', '[data-testid="subagent-overview-item"]')),
      1,
      'The subagent overview did not retain the streamed child conversation'
    )
    assert.equal(
      (await control.command('getText', '[data-testid="subagent-overview-panel"]')).includes(
        '正在工作'
      ),
      false,
      'A completed subagent retained the running preview'
    )
    await captureSubagent(control, 'streaming-text-subagent-04-completed-overview.png')

    await control.command('click', '[data-testid="right-workspace-subagents-tab-close-button"]')
    await control.command('waitFor', '[data-testid="environment-subagents-section"]', {
      timeoutMs: uiTimeoutMs,
    })
    await captureSubagent(control, 'streaming-text-subagent-05-environment-summary.png')

    const readyCountBeforeReload = control.readyCount
    await control.command('reloadMainWindow', 'body')
    await Promise.race([
      control.awaitReadyAfter(readyCountBeforeReload),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('The reloaded Wework window did not reconnect')),
          uiTimeoutMs
        )
      ),
    ])
    await control.command('waitFor', '[data-testid="environment-subagents-section"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="open-subagents-panel-button"]')
    await control.command('waitFor', '[data-testid="subagent-overview-panel"]', {
      timeoutMs: uiTimeoutMs,
    })
    assert.equal(
      await control.command('getAttribute', '[data-testid="right-workspace-subagents-tab"]', {
        value: 'aria-selected',
      }),
      'true',
      'The restored subagent overview was not opened inside the right workspace tab'
    )
    await control.command('click', '[data-testid="subagent-overview-item"]')
    await control.command('waitFor', '[data-testid="subagent-conversation-panel"]', {
      text: SUBAGENT_CHILD_FINAL,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', '[data-testid="subagent-conversation-scroll"]', {
      text: SUBAGENT_CHILD_TOOL_MARKER,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', '[data-testid="subagent-conversation-scroll"]', {
      text: SUBAGENT_CHILD_PARTIAL,
      timeoutMs: uiTimeoutMs,
    })
    for (const text of [SUBAGENT_CHILD_REASONING, SUBAGENT_CHILD_COMMENTARY]) {
      await control.command('waitFor', '[data-testid="subagent-conversation-scroll"]', {
        text,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        (await control.command('getText', ASSISTANT_CONTENT_SELECTOR)).includes(text),
        false,
        'The restored child process content leaked into the root conversation'
      )
    }
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: SUBAGENT_PARENT_COMPLETION,
      timeoutMs: uiTimeoutMs,
    })
    assert.equal(
      (await control.command('getText', '[data-testid="subagent-conversation-scroll"]')).includes(
        SUBAGENT_PARENT_COMPLETION
      ),
      false,
      'The restored child conversation loaded the root final answer'
    )
    assert.equal(
      (await control.command('getText', ASSISTANT_CONTENT_SELECTOR)).includes(
        SUBAGENT_CHILD_TOOL_MARKER
      ),
      false,
      'The restored child tool leaked into the root conversation'
    )
    assert.equal(
      (await control.command('getText', ASSISTANT_CONTENT_SELECTOR)).includes(SUBAGENT_CHILD_FINAL),
      false,
      'The restored child final answer leaked into the root conversation'
    )
    assert.equal(
      (await control.command('getText', ASSISTANT_CONTENT_SELECTOR)).includes(
        SUBAGENT_CHILD_PARTIAL
      ),
      false,
      'The restored child stream leaked into the root conversation'
    )
    await captureSubagent(control, 'streaming-text-subagent-06-restored-history.png')
    await control.command('click', '[data-testid="right-workspace-subagents-tab-close-button"]')
    await control.command('setMainWindowSize', 'body', { value: JSON.stringify(previousSize) })
  }

  const verifyTools = async control => {
    await verifyLongCodeTerminalBurst(control)
    await verifyWindowsDriveLinkRendering(control)

    await openNewChatWithE2EModel(control, uiTimeoutMs)
    const knownLegacyTaskRows = new Set(
      JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
        testId.startsWith('runtime-local-task-row-')
      )
    )
    await control.command('fill', COMPOSER_SELECTOR, { value: LEGACY_CONVERSATION_PROMPT })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: LEGACY_CONVERSATION_COMPLETION,
      timeoutMs: uiTimeoutMs,
    })
    const legacyTaskRowTestId = await waitForNewTaskRow(
      control,
      knownLegacyTaskRows,
      LEGACY_CONVERSATION_PROMPT,
      uiTimeoutMs
    )
    for (let index = 0; index < PANE_EVICTION_BLANK_COUNT; index += 1) {
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
    }
    await control.command('clickWhenEnabled', `[data-testid="${legacyTaskRowTestId}"]`, {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: LEGACY_CONVERSATION_COMPLETION,
      stableMs: 750,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', COMPOSER_SELECTOR, { value: PHASE_FLIP_PROMPT })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: PHASE_FLIP_TEXT,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('reconcileLegacyRuntimeAssistantSnapshot', 'body', {
      value: JSON.stringify({
        address: {
          deviceId: 'local-device',
          taskId: legacyTaskRowTestId.replace('runtime-local-task-row-', ''),
        },
        content: PHASE_FLIP_TEXT,
        itemId: LEGACY_TRANSCRIPT_ITEM_ID,
      }),
    })
    const streamingPhaseFlipSnapshot = JSON.parse(
      await control.command('snapshot', SCROLLER_SELECTOR)
    )
    assert.equal(
      streamingPhaseFlipSnapshot.text.split(PHASE_FLIP_TEXT).length - 1,
      1,
      'Streaming final text was rendered more than once before the turn completed'
    )
    releasePhaseFlipCompletion()
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
      { stableMs: 750, timeoutMs: uiTimeoutMs }
    )
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: PHASE_FLIP_TEXT,
      stableMs: 750,
      timeoutMs: uiTimeoutMs,
    })
    const phaseFlipSnapshot = JSON.parse(await control.command('snapshot', SCROLLER_SELECTOR))
    assert.equal(
      phaseFlipSnapshot.text.split(PHASE_FLIP_TEXT).length - 1,
      1,
      'The terminal final content was rendered more than once'
    )
    assert.equal(
      Number(await control.command('getElementCount', PROCESS_TEXT_SELECTOR)),
      0,
      'The promoted final content remained duplicated in the process section'
    )
    await capture(control, 'streaming-text-00-legacy-follow-up-promoted-once.png')
    if (process.env.WEWORK_E2E_LEGACY_STREAM_ONLY === 'true') {
      return
    }

    await openNewChatWithE2EModel(control, uiTimeoutMs)
    await control.command('fill', COMPOSER_SELECTOR, { value: TOOL_REGRESSION_PROMPT })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    try {
      await Promise.race([
        toolFollowUpReceived,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('The tool-output follow-up request was not received')),
            modelResponseTimeoutMs
          )
        ),
      ])
    } catch (error) {
      releaseToolCompletion()
      releaseToolFinalCompletion()
      throw error
    }
    await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
      text: TOOL_PREAMBLE,
      timeoutMs: modelResponseTimeoutMs,
    })
    assert.equal(
      Number(await control.command('getElementCount', ASSISTANT_CONTENT_SELECTOR)),
      0,
      'The unphased pre-tool process text was exposed as final assistant content'
    )
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="final-processing-toggle"]`
        )
      ),
      0,
      'The tool timeline collapsed before authoritative final content arrived'
    )
    await capture(control, 'streaming-text-00-unphased-process-before-tool.png')
    await control.command('waitFor', TOOL_THINKING_INDICATOR_SELECTOR, {
      text: `正在思考 · ${REASONING_PREVIEW}`,
      timeoutMs: modelResponseTimeoutMs,
    })
    await capture(control, 'streaming-text-01-live-reasoning-summary.png')
    releaseToolCompletion()
    await toolFinalTextStarted
    await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
      text: TOOL_COMPLETION,
      timeoutMs: modelResponseTimeoutMs,
    })
    assert.equal(
      Number(await control.command('getElementCount', ASSISTANT_CONTENT_SELECTOR)),
      0,
      'The unphased post-tool text became final before the turn completed'
    )
    releaseToolFinalCompletion()
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: TOOL_COMPLETION,
      timeoutMs: modelResponseTimeoutMs,
    })
    const liveFinalTextSnapshot = JSON.parse(
      await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
    )
    assert.equal(
      liveFinalTextSnapshot.text.includes(REASONING_PREVIEW),
      false,
      'The stale reasoning summary remained visible after assistant text started streaming'
    )
    await capture(control, 'streaming-text-02-reasoning-hidden-during-text.png')
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
      { stableMs: 750, timeoutMs: uiTimeoutMs }
    )
    const completedProcessingToggle = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="final-processing-toggle"]`
    await control.command('waitFor', completedProcessingToggle, { timeoutMs: uiTimeoutMs })
    assert.equal(
      await control.command('getAttribute', completedProcessingToggle, {
        value: 'aria-expanded',
      }),
      'false',
      'The completed stream left its process timeline expanded instead of collapsing it'
    )
    const toolRegressionSnapshot = JSON.parse(
      await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
    )
    assert.ok(
      toolRegressionSnapshot.text.includes(TOOL_COMPLETION),
      'The assistant text after the tool call lost its prefix'
    )
    assert.equal(
      toolRegressionSnapshot.text.includes(REASONING_SUMMARY),
      false,
      'The collapsed reasoning disclosure exposed its full summary'
    )
    await capture(control, 'streaming-text-03-processing-collapsed.png')
    await control.command('click', '[data-testid="final-processing-toggle"]')
    const expandedProcessingSnapshot = JSON.parse(
      await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
    )
    assert.equal(
      expandedProcessingSnapshot.testIds.includes('thinking-toggle-button'),
      false,
      'The completed response retained a reasoning placeholder'
    )
    assert.equal(
      expandedProcessingSnapshot.text.includes(REASONING_SUMMARY),
      false,
      'The completed response retained its reasoning summary'
    )
    await capture(control, 'streaming-text-04-reasoning-removed.png')
    const shortConversationScroller = await waitForBottom(
      control,
      'The short control conversation',
      uiTimeoutMs
    )
    await assertComposerDocked(
      control,
      shortConversationScroller,
      'The composer in the short control conversation'
    )
    await capture(control, 'streaming-text-05-short-control-composer-docked.png')

    await openNewChatWithE2EModel(control, uiTimeoutMs)
    await control.command('fill', COMPOSER_SELECTOR, {
      value: TOOL_DETAIL_PERSISTENCE_PROMPT,
    })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    try {
      await Promise.race([
        toolDetailPersistenceFollowUpReceived,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(new Error('The tool-detail-persistence follow-up request was not received')),
            uiTimeoutMs
          )
        ),
      ])
    } catch (error) {
      releaseToolDetailPersistenceFinalText()
      releaseToolDetailPersistenceCompletion()
      throw error
    }
    const collapsedToolDetailSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-processing-block-id="${TOOL_DETAIL_PERSISTENCE_CALL_ID}"] [data-tool-detail-toggle][aria-label="展开工具详情"]`
    const expandedToolDetailSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-processing-block-id="${TOOL_DETAIL_PERSISTENCE_CALL_ID}"] [data-tool-detail-toggle][aria-label="收起工具详情"]`
    await control.command('waitFor', collapsedToolDetailSelector, {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', collapsedToolDetailSelector)
    await control.command('waitFor', expandedToolDetailSelector, {
      timeoutMs: uiTimeoutMs,
    })
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-processing-block-id="${TOOL_DETAIL_PERSISTENCE_CALL_ID}"]`,
      {
        text: TOOL_DETAIL_PERSISTENCE_OUTPUT,
        timeoutMs: uiTimeoutMs,
      }
    )

    releaseToolDetailPersistenceFinalText()
    await toolDetailPersistenceFinalTextStarted
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: TOOL_DETAIL_PERSISTENCE_COMPLETION,
      timeoutMs: uiTimeoutMs,
    })
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="final-processing-toggle"]`
        )
      ),
      0,
      'The expanded tool detail collapsed when final text started streaming'
    )
    assert.equal(
      Number(await control.command('getElementCount', expandedToolDetailSelector)),
      1,
      'The tool detail did not remain expanded while final text streamed'
    )

    releaseToolDetailPersistenceCompletion()
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
      { stableMs: 750, timeoutMs: uiTimeoutMs }
    )
    assert.equal(
      await control.command(
        'getAttribute',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="final-processing-toggle"]`,
        { value: 'aria-expanded' }
      ),
      'true',
      'The expanded tool detail collapsed when the turn completed'
    )
    assert.equal(
      Number(await control.command('getElementCount', expandedToolDetailSelector)),
      1,
      'The tool detail did not remain expanded after the turn completed'
    )

    await control.command('click', expandedToolDetailSelector)
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="final-processing-toggle"]`,
      { timeoutMs: uiTimeoutMs }
    )
    assert.equal(
      await control.command(
        'getAttribute',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="final-processing-toggle"]`,
        { value: 'aria-expanded' }
      ),
      'false',
      'The completed processing timeline did not collapse after the user closed tool details'
    )
  }
  return {
    verifyLongCodeTerminalBurst,
    verifyStoppedTurnOrder,
    verifySubagentStreamingPanel,
    verifyTools,
  }
}
