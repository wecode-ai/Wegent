import assert from 'node:assert/strict'
import { getSingleElementMetrics } from './conversation-layout.mjs'
import { withProjectRenderer } from './project-create-test-utils.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

const testId = name => `[data-testid="${name}"]`
const addConnection = testId('stand-in-dingtalk-add')
const connectionKind = testId('stand-in-dingtalk-kind')
const templates = ['document', 'schedule', 'process'].map(kind =>
  testId(`stand-in-delegation-template-${kind}`)
)
const noSources = testId('stand-in-delegation-no-sources')
const enable = testId('stand-in-delegation-enable')
const save = testId('stand-in-primary-save')
const appearanceKey = 'wework.appearance'

async function rendererValue(expression) {
  return withProjectRenderer(async (client, target) => {
    const result = await client({
      action: 'command',
      target,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true },
    })
    assert.equal(result.exceptionDetails, undefined, 'Reading the delegation renderer failed')
    return result.result?.value
  })
}

async function applyAppearance(control, value, resolvedMode) {
  // Exercise the renderer's preference sync from another window without leaving the open form.
  await rendererValue(`(() => {
    const key = ${JSON.stringify(appearanceKey)}
    const oldValue = localStorage.getItem(key)
    const newValue = ${JSON.stringify(value)}
    if (newValue === null) localStorage.removeItem(key)
    else localStorage.setItem(key, newValue)
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage }))
  })()`)
  await control.command('waitFor', `html[data-theme="${resolvedMode}"]`)
}

const resize = async (control, size) =>
  JSON.parse(await control.command('setMainWindowSize', 'body', { value: JSON.stringify(size) }))

async function checkControlInView(control, selector, narrow) {
  await control.command('scrollIntoViewAsUser', selector)
  const metrics = await waitForValue(
    () => getSingleElementMetrics(control, selector, selector),
    value =>
      value?.visibleIntersection &&
      value.viewportWidth === (narrow ? 390 : 1440) &&
      value.visibleIntersection.width >= value.width - 1 &&
      value.visibleIntersection.height >= value.height - 1,
    `Delegation setting is clipped at the requested viewport: ${selector}`,
    DEFAULT_STEP_TIMEOUT_MS
  )
  assert.ok(metrics.width > 0 && metrics.height > 0, `Empty delegation control: ${selector}`)
  if (narrow && templates.includes(selector)) {
    assert.ok(metrics.width >= 44 && metrics.height >= 44, `Small touch target: ${selector}`)
  }
}

async function waitForKeyboardFocus(selector) {
  return waitForValue(
    () =>
      rendererValue(`(() => {
        const target = document.querySelector(${JSON.stringify(selector)})
        if (!(target instanceof HTMLElement)) return null
        return {
          active: document.activeElement === target,
          focused: target.matches(':focus'),
          modality: document.documentElement.dataset.inputModality,
          boxShadow: getComputedStyle(target).boxShadow,
        }
      })()`),
    value =>
      value?.active &&
      value.focused &&
      value.modality === 'keyboard' &&
      value.boxShadow &&
      value.boxShadow !== 'none',
    `Keyboard focus is not visible for ${selector}`,
    DEFAULT_STEP_TIMEOUT_MS
  )
}

async function verifyKeyboard(control, captureScreenshot) {
  const [document, schedule, process] = templates
  await control.command('nativePress', connectionKind, { key: 'Enter' })
  await control.command('waitFor', `${connectionKind}[aria-expanded="true"]`)
  await control.command('nativePress', ':focus', { key: 'Escape' })
  await control.command('waitFor', `${connectionKind}[aria-expanded="false"]`)
  await control.command('nativePress', document, { key: 'Tab' })
  await waitForKeyboardFocus(schedule)
  await control.command('nativePress', schedule, { key: 'Tab' })
  await waitForKeyboardFocus(process)
  await control.command('nativePress', process, { key: 'Shift+Tab' })
  await waitForKeyboardFocus(schedule)
  await captureScreenshot(control, 'stand-in-dingtalk-390-keyboard-focus.png')
  await control.command('nativePress', schedule, { key: 'Space' })
  await control.command('waitFor', `${schedule}[aria-checked="false"]`)
  await control.command('waitFor', `${document}[aria-checked="true"]`)
  await control.command('waitFor', `${process}[aria-checked="true"]`)
  await control.command('nativePress', schedule, { key: 'Space' })
  await control.command('waitFor', `${schedule}[aria-checked="true"]`)
}

export async function verifyStandInDelegationVisual(control, { captureScreenshot }) {
  // A migrated row displays the Add Connection action before the source picker.
  await control.command('nativePress', addConnection, { key: 'Enter' })
  await control.command('waitFor', connectionKind)
  const stored = await control.command('getLocalStorageItem', 'body', { value: appearanceKey })
  const originalAppearance = stored || null
  const originalMode = await control.command('getAttribute', 'html', { value: 'data-theme' })
  const originalSize = await resize(control, { width: 1440, height: 900 })
  try {
    for (const width of [1440, 390]) {
      if (width === 390) await resize(control, { width, height: 900 })
      for (const mode of ['light', 'dark']) {
        const value = JSON.stringify({ ...JSON.parse(stored || '{}'), mode })
        await applyAppearance(control, value, mode)
        await control.command('waitFor', `${enable}:disabled`)
        for (const selector of [connectionKind, ...templates, enable, save, noSources]) {
          await checkControlInView(control, selector, width === 390)
        }
        await captureScreenshot(control, `stand-in-dingtalk-${width}-${mode}.png`)
      }
    }
    await verifyKeyboard(control, captureScreenshot)
  } finally {
    try {
      await applyAppearance(control, originalAppearance, originalMode)
    } finally {
      await resize(control, originalSize)
    }
  }
}
