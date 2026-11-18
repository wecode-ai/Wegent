import {
  openNewChatWithE2EModel,
  COMPOSER_SELECTOR,
  ASSISTANT_CONTENT_SELECTOR,
  SUBAGENT_PROMPT,
  SUBAGENT_CHILD_PARTIAL,
  SUBAGENT_CHILD_TOOL_MARKER,
  SUBAGENT_CHILD_REASONING,
  SUBAGENT_CHILD_COMMENTARY,
  SUBAGENT_CHILD_FINAL,
  SUBAGENT_PARENT_COMPLETION,
} from './streaming-text-fixture.mjs'
import assert from 'node:assert/strict'

export function createStreamingToolChecks({
  uiTimeoutMs,
  captureSubagent,
  subagentToolRenderTimeoutMs,
  subagentPartialWritten,
  releaseSubagentCompletion,
  beforeSubagentOutput,
}) {
  const verifySubagentStreamingPanel = async control => {
    // X11 shrinks display-sized normal frames by one pixel. Capture a maximized
    // baseline so cleanup can restore an attainable native window state.
    await control.command('setMainWindowSize', 'body', {
      value: JSON.stringify({ width: 1280, height: 720, maximized: true }),
    })
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
    await control.command('click', '[data-testid="subagent-activity-chip"]')
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
    await beforeSubagentOutput?.(control)
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
  return {
    verifySubagentStreamingPanel,
  }
}
