import assert from 'node:assert/strict'
import { getSingleElementMetrics } from './conversation-layout.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'
import { withProjectRenderer } from './project-create-test-utils.mjs'
import { assertModelAccessibilityIsolation } from './project-create-accessibility.mjs'
import { verifyReasoningSliderAccessibility } from './project-create-reasoning-slider.mjs'

const MENU = '[data-testid="model-selector-menu"]'

async function readModelDialog() {
  return withProjectRenderer(async (client, target) => {
    const result = await client({
      action: 'command',
      target,
      method: 'Runtime.evaluate',
      params: {
        returnByValue: true,
        expression: `(() => {
          const panel = document.querySelector('${MENU}')
          const dialog = panel?.closest('[role="dialog"]')
          if (!dialog) return null
          const visible = element => {
            if (element.closest('[hidden],[inert],[aria-hidden="true"]')) return false
            for (let node = element; node; node = node.parentElement) {
              const style = getComputedStyle(node)
              if (style.display === 'none' || style.visibility === 'hidden') return false
            }
            return true
          }
          const selector = element => {
            const path = []
            while (element && element !== dialog) {
              path.unshift(element.tagName.toLowerCase() + ':nth-child(' + (Array.from(element.parentElement.children).indexOf(element) + 1) + ')')
              element = element.parentElement
            }
            return '[data-model-selector-layer="true"] > ' + path.join(' > ')
          }
          const focusable = Array.from(dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter(element => element.tabIndex >= 0 && visible(element))
          const radios = Array.from(dialog.querySelectorAll('[role="radiogroup"] [role="radio"]')).filter(element => visible(element) && element.getAttribute('aria-disabled') !== 'true')
          return { name: dialog.getAttribute('aria-label'), modal: dialog.getAttribute('aria-modal'),
            focusedInside: dialog.contains(document.activeElement),
            focusedIndex: focusable.indexOf(document.activeElement),
            focusable: focusable.map(selector),
            radios: radios.map(element => ({ selector: selector(element), checked: element.getAttribute('aria-checked') === 'true', tabIndex: element.tabIndex })) }
        })()`,
      },
    })
    return result.result?.value
  })
}

/** Real key events must enter the portaled picker, wrap there, and return to its opener. */
export async function verifyModelDialogKeyboard(control, configuration) {
  const trigger = `${configuration} [data-testid="model-selector-button"]`
  await control.command('nativePress', trigger, { key: 'Enter' })
  await control.command('waitFor', MENU, { visible: true })
  let state = await waitForValue(
    readModelDialog,
    value => value?.focusedInside && value.focusable.length > 0,
    'The portaled model dialog did not receive keyboard focus',
    DEFAULT_STEP_TIMEOUT_MS
  )
  assert.ok(state.name, 'The model dialog must have an accessible name')
  assert.equal(state.modal, 'true')
  await assertModelAccessibilityIsolation('open', true)
  await control.command('nativePress', state.focusable.at(-1), { key: 'Tab' })
  state = await readModelDialog()
  assert.equal(state.focusedIndex, 0, 'Tab must wrap inside the model dialog')
  await control.command('nativePress', state.focusable[0], { key: 'Shift+Tab' })
  state = await readModelDialog()
  assert.equal(state.focusedIndex, state.focusable.length - 1)
  if ((await control.command('getAttribute', MENU, { value: 'data-panel' })) === 'simple')
    await control.command('clickWhenEnabled', `${MENU} [data-testid="model-advanced-toggle"]`)
  state = await waitForValue(
    readModelDialog,
    value => value?.focusedInside && value.radios.length > 0,
    'Advanced models must retain focus inside their dialog',
    DEFAULT_STEP_TIMEOUT_MS
  )
  assert.equal(state.radios.filter(radio => radio.tabIndex === 0).length, 1)
  const current = Math.max(
    0,
    state.radios.findIndex(radio => radio.checked)
  )
  const next = state.radios[(current + 1) % state.radios.length]
  await control.command('nativePress', state.radios[current].selector, { key: 'ArrowDown' })
  await control.command('waitFor', `${next.selector}[aria-checked="true"]`, {})
  await control.command('nativePress', ':focus', { key: 'Escape' })
  await control.command('waitFor', MENU, { visible: false })
  assert.equal(await control.command('getActiveElementTestId', 'body'), 'model-selector-button')
  await control.command('waitFor', configuration, { visible: true })
  await assertModelAccessibilityIsolation('restored', false)
  await verifyReasoningSliderAccessibility(control, trigger)
}

export async function assertMobileInlineTarget(control, selector) {
  const metrics = await getSingleElementMetrics(control, selector, selector)
  assert.ok(
    metrics.width >= 44 && metrics.height >= 44,
    `The mobile inline editor must have a 44px target: ${JSON.stringify(metrics)}`
  )
}
