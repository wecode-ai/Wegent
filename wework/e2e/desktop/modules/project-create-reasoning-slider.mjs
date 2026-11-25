import assert from 'node:assert/strict'
import { DEFAULT_MODEL_ID, verifyModelPickerEscape } from './shared.mjs'
import { withProjectRenderer } from './project-create-test-utils.mjs'
import { assertProjectKeyboardFocus } from './project-create-focus-indicator.mjs'

const MENU = '[data-testid="model-selector-menu"]'
const TRACK = `${MENU} [data-testid="model-control-reasoning-track"]`

/** Reuse the checkpoint's configured GPT model and its real catalog controls. */
export async function verifyReasoningSliderAccessibility(control, trigger) {
  await control.command('nativePress', trigger, { key: 'Enter' })
  await control.command('waitFor', MENU, { visible: true })
  if ((await control.command('getAttribute', MENU, { value: 'data-panel' })) === 'simple')
    await control.command('clickWhenEnabled', `${MENU} [data-testid="model-advanced-toggle"]`)
  const option = `${MENU} [data-testid="model-option-${DEFAULT_MODEL_ID}"]`
  await control.command('waitFor', option, { visible: true })
  await control.command('clickWhenEnabled', option)
  await control.command('waitFor', `${option}[aria-checked="true"]`)
  await control.command('waitFor', TRACK, { visible: true })
  const name = await control.command('getAttribute', TRACK, { value: 'aria-label' })
  assert.equal(name, '推理强度')
  const describedBy = await control.command('getAttribute', TRACK, { value: 'aria-describedby' })
  assert.ok(describedBy, 'The fixed-model reasoning control must reference its explanation')
  const description = await control.command(
    'getText',
    `${MENU} [id=${JSON.stringify(describedBy)}]`
  )
  assert.ok(description.trim())
  const ax = await withProjectRenderer(async (client, target) => {
    const command = (method, params = {}) => client({ action: 'command', target, method, params })
    const { root } = await command('DOM.getDocument', { depth: 0 })
    const { nodeId } = await command('DOM.querySelector', { nodeId: root.nodeId, selector: TRACK })
    assert.ok(nodeId, 'The real reasoning slider must be mounted')
    const { node } = await command('DOM.describeNode', { nodeId })
    const { nodes } = await command('Accessibility.getPartialAXTree', {
      backendNodeId: node.backendNodeId,
      fetchRelatives: false,
    })
    return nodes.find(entry => entry.backendDOMNodeId === node.backendNodeId)
  })
  assert.equal(ax?.ignored, false)
  assert.equal(ax.role?.value, 'slider')
  assert.equal(ax.name?.value, name)
  assert.equal(
    ax.description?.value?.replace(/\s+/g, ' ').trim(),
    description.replace(/\s+/g, ' ').trim()
  )
  const minimum = Number(await control.command('getAttribute', TRACK, { value: 'aria-valuemin' }))
  const maximum = Number(await control.command('getAttribute', TRACK, { value: 'aria-valuemax' }))
  assert.ok(Number.isFinite(minimum) && maximum > minimum)
  for (const [key, expected] of [
    ['Home', minimum],
    ['End', maximum],
    ['ArrowLeft', maximum - 1],
  ]) {
    await control.command('nativePress', TRACK, { key })
    await control.command('waitFor', `${TRACK}[aria-valuenow="${expected}"]`, { visible: true })
    assert.ok((await control.command('getAttribute', TRACK, { value: 'aria-valuetext' })).trim())
  }
  const thumb = `${MENU} [data-testid="model-control-reasoning-thumb"]`
  await assertProjectKeyboardFocus(thumb, { focusSelector: TRACK })
  await control.command('nativePress', TRACK, { key: 'Shift+Tab' })
  const lastStep = `${MENU} button[data-testid^="model-control-reasoning-"]:last-of-type`
  await assertProjectKeyboardFocus(lastStep)
  assert.equal(
    await control.command('getComputedStyleValue', lastStep, { value: 'box-shadow' }),
    'none',
    'The focused reasoning step must paint just its keyboard outline'
  )
  await verifyModelPickerEscape(control, lastStep, 'nativePress', () =>
    control.command('waitFor', MENU, { visible: false })
  )
  assert.equal(await control.command('getActiveElementTestId', 'body'), 'model-selector-button')
}
