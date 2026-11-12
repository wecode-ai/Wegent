import {
  ACTIVE_WORKBENCH_SELECTOR,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  FRESH_CHAT_PROMPT,
  assert,
  join,
  resultDir,
  selectE2EModel,
  writeFile,
} from './shared.mjs'
import { sendPrompt } from './conversation-navigation.mjs'
import { waitForElementCount } from './harness-app-fixture.mjs'

import {
  DIAGRAM_REGRESSION_LAST_SECTION,
  DIAGRAM_REGRESSION_MARKER,
} from './conversation-diagram-fixture.mjs'

export async function verifyConversationDiagrams(control, composerSelector, restoreTaskRow) {
  const selector = id => `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="${id}"]`
  const scroller = selector('desktop-workbench-content')
  const preview = selector('assistant-diagram-preview')
  const image = selector('diagram-image')
  await control.command('clickWhenEnabled', '[data-testid="new-chat-button"]')
  try {
    await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
    await sendPrompt(control, composerSelector, `${FRESH_CHAT_PROMPT} ${DIAGRAM_REGRESSION_MARKER}`)
    await control.command('waitFor', selector('message-assistant'), {
      text: `Diagram regression section ${DIAGRAM_REGRESSION_LAST_SECTION}`,
    })
    await control.command('scrollToRatioAsUser', scroller, { value: '0.5' })
    await control.command('waitFor', `${preview}[data-diagram-status="ready"]`)
    const source = await control.command('getAttribute', image, { value: 'src' })
    assert.ok(
      source.startsWith('data:image/svg+xml;'),
      'The transcript must display a compiled diagram image'
    )
    assert.equal(
      Number(await control.command('getElementCount', `${selector('diagram-pan-canvas')} svg`)),
      0
    )
    await control.command('click', selector('diagram-zoom-in-button'))
    await control.command('click', selector('diagram-zoom-reset-button'))
    await control.command('click', selector('diagram-fullscreen-button'))
    await control.command(
      'waitFor',
      '[data-testid="assistant-diagram-fullscreen"] [data-diagram-status="ready"]'
    )
    assert.equal(
      await control.command(
        'getAttribute',
        '[data-testid="assistant-diagram-fullscreen"] [data-testid="diagram-image"]',
        { value: 'src' }
      ),
      source
    )
    await control.command('press', 'body', { key: 'Escape' })
    await control.command('waitFor', `${preview}[data-diagram-status="ready"]`)
    await control.command('scrollToRatioAsUser', scroller, { value: '1' })
    await control.command('waitFor', selector('message-assistant'), {
      text: `Diagram regression section ${DIAGRAM_REGRESSION_LAST_SECTION}`,
      stableMs: 300,
    })
    await waitForElementCount(
      control,
      image,
      0,
      DEFAULT_STEP_TIMEOUT_MS,
      'The middle Markdown chunk did not unmount outside the preparation window'
    )
    assert.equal(
      Number(await control.command('getElementCount', image)),
      0,
      'The middle Markdown chunk must unmount outside the preparation window'
    )
    await control.command('scrollToRatioAsUser', scroller, { value: '0.5' })
    await control.command('waitFor', `${preview}[data-diagram-status="ready"]`)
    assert.equal(
      await control.command('getAttribute', image, { value: 'src' }),
      source,
      'Returning to the graph must reuse the compiled artifact'
    )
  } catch (error) {
    // Capture the failing transcript before restoring the previous task below.
    const diagnostics = await Promise.allSettled([
      control.command('getWorkbenchDebugSnapshot', 'body'),
      control.command('getConversationDiagnosticsSnapshot', 'body'),
      control.command('getElementMetrics', scroller),
      control.command(
        'getElementMetrics',
        `${selector('message-assistant')} [data-markdown-window-chunk]`
      ),
      control.command('getElementMetrics', preview),
    ])
    await writeFile(
      join(resultDir, 'conversation-diagram-failure.json'),
      JSON.stringify(
        {
          error: error instanceof Error ? error.stack : String(error),
          diagnostics: diagnostics.map(result =>
            result.status === 'fulfilled'
              ? result
              : { status: result.status, reason: String(result.reason?.stack ?? result.reason) }
          ),
        },
        null,
        2
      )
    ).catch(captureError => console.error('Cannot save diagram failure diagnostics', captureError))
    throw error
  } finally {
    if (
      Number(
        await control.command('getElementCount', '[data-testid="diagram-exit-fullscreen-button"]')
      )
    ) {
      await control.command('click', '[data-testid="diagram-exit-fullscreen-button"]')
    }
    await control.command('clickWhenEnabled', `[data-testid="${restoreTaskRow}"]`)
  }
}
