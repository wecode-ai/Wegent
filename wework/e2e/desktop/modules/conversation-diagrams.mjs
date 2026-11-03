import {
  ACTIVE_WORKBENCH_SELECTOR,
  ACTIVE_SEND_BUTTON_SELECTOR,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  FRESH_CHAT_PROMPT,
  assert,
  selectE2EModel,
} from './shared.mjs'
import { sendPrompt } from './conversation-navigation.mjs'
import { waitForElementCount } from './harness-app-fixture.mjs'

import { DIAGRAM_REGRESSION_MARKER } from './conversation-diagram-fixture.mjs'

async function revealConversationDiagram(control) {
  const chunk = `${ACTIVE_WORKBENCH_SELECTOR} [data-markdown-window-chunk]`
  const text = 'Diagram regression section 8'
  await control.command('waitFor', chunk, { text })
  // Transcript reconciliation can change the total height after the reply appears.
  await control.command('scrollIntoViewAsUser', chunk, { text })
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-diagram-preview"][data-diagram-status="ready"]`
  )
}

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
      text: 'Diagram regression section 16',
    })
    await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, {
      stableMs: COMPOSER_READY_STABILITY_MS,
    })
    await revealConversationDiagram(control)
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
      text: 'Diagram regression section 16',
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
    await revealConversationDiagram(control)
    assert.equal(
      await control.command('getAttribute', image, { value: 'src' }),
      source,
      'Returning to the graph must reuse the compiled artifact'
    )
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
