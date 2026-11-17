import assert from 'node:assert/strict'
import { waitForElementWidth } from './layout-metrics.mjs'
import { selectWorkbenchTheme } from './appearance-theme.mjs'
import { assertReadableSurface } from './ui-contrast.mjs'

const VOICE = '[data-testid="composer-voice-input"] button'
const GUIDE_ACTION = '[role="dialog"] button[data-modal-autofocus]'
const MODAL = '.wework-voice-setup-modal'
const CONTENT = '.wework-voice-setup-content'
const BODY = `${CONTENT} > :last-child`
const CLOSE = '[data-testid="voice-input-setup-close"]'
const HELP = '[data-testid="voice-input-model-help"]'

/** Use the application's preference, independent of the OS media query. */
async function verifyVoiceThemePreference(control, mode) {
  await selectWorkbenchTheme(control, { mode, themeId: 'wework' })
  await control.command(
    'waitFor',
    mode === 'dark' ? 'body[data-ds-dark-theme]' : 'body:not([data-ds-dark-theme])'
  )
  await control.command('navigate', 'body', { value: '/settings/general' })
  await control.command('waitFor', '[data-testid="voice-input-settings"]')
  const segments = JSON.parse(
    await control.command(
      'getElementMetrics',
      '[data-testid="general-settings-basic-section"] [role="group"] button'
    )
  )
  assert.ok(
    segments.length >= 9,
    'General settings must retain its mode, language, send and follow-up controls'
  )
  for (const box of segments)
    assert.ok(
      box.width >= 44 && box.height >= 44,
      `Narrow General setting target: ${JSON.stringify(box)}`
    )
  const controls = JSON.parse(
    await control.command(
      'getElementMetrics',
      '[data-testid="general-settings-page"] button:not(:disabled), [data-testid="general-settings-page"] select:not(:disabled)'
    )
  )
  for (const box of controls.filter(box => box.width > 0 && box.height > 0))
    assert.ok(box.width >= 44 && box.height >= 44, 'Narrow General control: ' + JSON.stringify(box))
  for (const id of ['settings-back-button', 'settings-nav-git-hosting', 'settings-nav-general']) {
    const box = await metrics(control, '[data-testid="' + id + '"]')
    assert.ok(
      box.width >= 44 && box.height >= 44,
      'Narrow settings navigation target: ' + JSON.stringify({ id, box })
    )
  }
  for (const category of ['coding', 'personal', 'integrations']) {
    await assertReadableSurface(
      control,
      '[data-testid="wework-settings-page"] > aside',
      '[data-testid="settings-category-' + category + '"]',
      ['body', '[data-testid="wework-settings-page"]']
    )
  }
  const language = await control.command('getAttribute', 'html', { value: 'lang' })
  assert.equal(
    (await control.command('getText', '[data-testid="settings-category-coding"]')).trim(),
    language.startsWith('en') ? 'Coding' : '编码',
    'General settings categories must follow the selected interface language'
  )
  await assertReadableSurface(
    control,
    'body',
    '[data-testid="voice-input-settings"] .wework-voice-preparation'
  )
  await control.command('navigate', 'body', { value: '/' })
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', `${VOICE}:not(:disabled)`)
  await control.command('click', VOICE)
  await control.command('waitFor', GUIDE_ACTION)
  await assertReadableSurface(control, '[role="dialog"]:has(button[data-modal-autofocus])')
  await control.command('click', GUIDE_ACTION)
  await control.command('waitFor', '[data-testid="voice-input-setup"] select')
  await assertReadableSurface(control, MODAL, `${MODAL} .wework-voice-preparation`)
  await control.command('click', CLOSE)
  await control.command('waitFor', MODAL, { visible: false })
}

export async function verifyVoiceThemeTransitions(control) {
  const previous = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 760, height: 760 }),
  })
  try {
    await waitForElementWidth(
      control,
      'body',
      width => width > 0 && width <= 767,
      'Settings narrow viewport'
    )
    for (const mode of ['dark', 'light']) await verifyVoiceThemePreference(control, mode)
  } finally {
    await control.command('setMainWindowSize', 'body', { value: previous })
  }
}

async function metrics(control, selector) {
  const values = JSON.parse(await control.command('getElementMetrics', selector))
  assert.equal(values.length, 1, `Expected one ${selector}: ${JSON.stringify(values)}`)
  return values[0]
}

function assertInViewport(value, label) {
  assert.ok(
    value.width > 0 &&
      value.height > 0 &&
      value.top >= 0 &&
      value.left >= 0 &&
      value.bottom <= value.viewportHeight + 1 &&
      value.right <= value.viewportWidth + 1,
    `${label} must remain inside the viewport: ${JSON.stringify(value)}`
  )
}

async function assertNarrowTargets(control, selector) {
  const values = JSON.parse(await control.command('getElementMetrics', selector))
  assert.ok(values.length > 0, `Missing narrow-window controls: ${selector}`)
  for (const value of values) {
    assert.ok(
      value.width >= 44 && value.height >= 44,
      `Narrow-window controls must be at least 44x44: ${selector}: ${JSON.stringify(value)}`
    )
  }
}

export async function assertVoicePreparationLayout(control) {
  const before = await metrics(control, MODAL)
  assertInViewport(before, 'Voice preparation dialog')
  for (const selector of [
    `${CONTENT} > :first-child h2`,
    `${CONTENT} > :first-child button`,
    CLOSE,
  ]) {
    assertInViewport(await metrics(control, selector), selector)
  }
  const body = await metrics(control, BODY)
  assert.ok(body.scrollHeight > body.clientHeight, 'Short-window preparation body must overflow')
  assert.ok(
    ['auto', 'scroll'].includes(
      (await control.command('getStyle', BODY, { value: 'overflow-y' })).trim()
    ),
    'Voice preparation body must allow user scrolling'
  )
  await control.command('scrollToBottomAsUser', BODY)
  const after = await metrics(control, BODY)
  assert.ok(after.scrollTop > 0, 'Preparation body must scroll independently')
  assert.ok(
    after.scrollHeight - after.clientHeight - after.scrollTop <= 1,
    'Preparation body must reach its end'
  )
  const help = await metrics(control, HELP)
  assert.ok(
    help.top >= after.top - 1 && help.bottom <= after.bottom + 1,
    'Final model help must be visible at the end'
  )
  assertInViewport(help, 'Final model help')
  const modalAfter = await metrics(control, MODAL)
  assert.ok(Math.abs(modalAfter.top - before.top) <= 1, 'Scrolling must not move the dialog')
  assertInViewport(await metrics(control, CLOSE), 'Preparation footer close after scrolling')
  assertInViewport(
    await metrics(control, `${CONTENT} > :first-child button`),
    'Preparation header close after scrolling'
  )
  assertInViewport(
    await metrics(control, `${CONTENT} > :first-child h2`),
    'Preparation title after scrolling'
  )
}

/** Exercise only the first-use UI; never prepare a model or start recording. */
export async function verifyVoicePreparationLayout(control) {
  await control.command('waitFor', '[data-testid="new-chat-button"]')
  const previous = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 760, height: 760 }),
  })
  try {
    const viewport = await waitForElementWidth(
      control,
      'body',
      width => width > 0 && width <= 767,
      'Narrow voice viewport'
    )
    assert.ok(
      viewport.viewportWidth <= 767 &&
        viewport.viewportHeight > 0 &&
        viewport.viewportHeight <= 760,
      `Voice regression requires a short narrow viewport: ${JSON.stringify(viewport)}`
    )
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', `${VOICE}:not(:disabled)`)
    await control.command('click', VOICE)
    await control.command('waitFor', GUIDE_ACTION)
    await assertNarrowTargets(control, '[role="dialog"] button')
    await control.command('click', GUIDE_ACTION)
    await control.command('waitFor', '[data-testid="voice-input-setup"] select')
    await assertVoicePreparationLayout(control)
    const choices = JSON.parse(
      await control.command('getElementMetrics', `${MODAL} label > select`)
    )
    assert.ok(
      choices.length >= 3,
      'Preparation must expose recognition service, language and model source'
    )
    for (const choice of choices)
      assert.ok(
        choice.width >= 240,
        `Preparation choices need room for their values and arrow: ${JSON.stringify(choice)}`
      )
    await assertNarrowTargets(control, `${MODAL} button, ${MODAL} select, ${MODAL} [role="button"]`)
    await control.command('click', CLOSE)
    await control.command('waitFor', MODAL, { visible: false })
  } finally {
    await control.command('setMainWindowSize', 'body', { value: previous })
  }
}
