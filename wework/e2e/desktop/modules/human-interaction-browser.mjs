import assert from 'node:assert/strict'
import { waitForEmbeddedBrowserVisibility } from './embedded-browser-visibility.mjs'

const HOST = '[data-testid="workspace-browser-electron-webview"]'
const INPUT = '[data-testid="workspace-browser-url-input"]'
const TOGGLE =
  '[data-workspace-tab-portal-owner]:not([hidden]) [data-testid="toggle-right-workspace-panel-button"]'

export async function verifyHumanInteractionOverBrowser({
  control,
  releaseQuestion,
  question,
  answer,
  captureScreenshot,
  uiTimeoutMs,
  modelResponseTimeoutMs,
}) {
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', TOGGLE)
  await control.command('click', TOGGLE)
  await control.command('click', '[data-testid="right-workspace-browser-option"]')
  await control.command('waitFor', INPUT)
  await control.command('fill', INPUT, {
    value: `${control.url}/human-interactions-browser-fixture`,
  })
  await control.command('submit', INPUT)
  await control.command('waitFor', HOST)
  const label = await control.command('getAttribute', HOST, {
    value: 'data-wework-browser-webview',
  })
  assert.ok(label, 'The real browser host must expose its owning label')
  await waitForEmbeddedBrowserVisibility(
    control,
    label,
    true,
    uiTimeoutMs,
    'The real browser page never opened'
  )
  assert.equal(
    await control.command('getComputedStyleValue', HOST, { value: 'pointer-events' }),
    'auto'
  )
  await captureScreenshot(control, '10-browser-before-reminder.png')
  releaseQuestion()
  await control.command('waitFor', '[data-testid="runtime-interaction-notice"]', {
    text: question,
    timeoutMs: modelResponseTimeoutMs,
  })
  const deadline = Date.now() + uiTimeoutMs
  let pointerEvents
  do {
    pointerEvents = await control.command('getComputedStyleValue', HOST, {
      value: 'pointer-events',
    })
    if (pointerEvents === 'none') break
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.equal(
    pointerEvents,
    'none',
    'The browser guest must yield interaction to the global reminder'
  )
  await control.command('click', '[data-testid="interaction-notice-reply"]')
  await control.command(
    'fill',
    '[data-testid="runtime-interaction-notice"] [data-testid="interaction-reply-input"]',
    { value: answer }
  )
  await captureScreenshot(control, '11-quick-reply-above-real-browser.png')
  await control.command(
    'click',
    '[data-testid="runtime-interaction-notice"] [data-testid="interaction-reply-send"]'
  )
  await control.command('waitFor', '[data-testid="transient-notice"]', {
    text: '已回复',
    timeoutMs: modelResponseTimeoutMs,
  })
  const restoredDeadline = Date.now() + uiTimeoutMs
  do {
    pointerEvents = await control.command('getComputedStyleValue', HOST, {
      value: 'pointer-events',
    })
    if (pointerEvents === 'auto') break
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < restoredDeadline)
  assert.equal(pointerEvents, 'auto', 'The browser must regain interaction after the reply')
  await captureScreenshot(control, '12-browser-restored-after-reply.png')
}
