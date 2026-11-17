import assert from 'node:assert/strict'
import { DEFAULT_MODEL_ID, DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'
import { withProjectRenderer } from './project-create-test-utils.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

const MENU = '[data-testid="model-selector-menu"]'
const TRACK = `${MENU} [data-testid="model-control-reasoning-track"]`

function rgb(color) {
  assert.match(color, /^rgba?\(/, `Expected a computed RGB color, received ${color}`)
  const values = color.match(/[\d.]+/g).map(Number)
  return [...values.slice(0, 3), values[3] ?? 1]
}

function composite(foreground, background) {
  const alpha = foreground[3] + background[3] * (1 - foreground[3])
  return [
    ...foreground
      .slice(0, 3)
      .map((channel, index) =>
        alpha
          ? (channel * foreground[3] + background[index] * background[3] * (1 - foreground[3])) /
            alpha
          : 0
      ),
    alpha,
  ]
}

function luminance(color) {
  return color.slice(0, 3).reduce((sum, channel, index) => {
    const value = channel / 255
    return (
      sum +
      (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
        [0.2126, 0.7152, 0.0722][index]
    )
  }, 0)
}

async function assertReasoningKeyboardFocus(selector) {
  const readMetrics = () =>
    withProjectRenderer(async (client, target) => {
      const value = await client({
        action: 'command',
        target,
        method: 'Runtime.evaluate',
        params: {
          returnByValue: true,
          expression: `(() => {
        const element = document.querySelector(${JSON.stringify(selector)})
        if (!element) return null
        const style = getComputedStyle(element)
        const ancestors = []
        let parent = element.parentElement
        while (parent) {
          const parentStyle = getComputedStyle(parent)
          ancestors.push({ background: parentStyle.backgroundColor, opacity: Number(parentStyle.opacity) })
          parent = parent.parentElement
        }
        return { focused: document.activeElement === element && element.matches(':focus-visible'),
          outline: style.outlineColor, width: parseFloat(style.outlineWidth), style: style.outlineStyle,
          opacity: Number(style.opacity), ancestors }
      })()`,
        },
      })
      return value.result?.value
    })
  const metrics = await waitForValue(
    readMetrics,
    value => value?.opacity === 1 && value.ancestors.every(entry => entry.opacity === 1),
    'The model popup did not finish its opacity transition before focus verification',
    DEFAULT_STEP_TIMEOUT_MS
  )
  assert.ok(metrics?.focused, `Keyboard focus did not reach ${selector}`)
  assert.equal(metrics.style, 'solid')
  assert.ok(metrics.width >= 2)
  assert.equal(metrics.opacity, 1)
  assert.ok(metrics.ancestors.every(entry => entry.opacity === 1))
  const outline = rgb(metrics.outline)
  assert.equal(outline[3], 1, 'The focus outline must be opaque')
  const background = metrics.ancestors
    .toReversed()
    .reduce((result, entry) => composite(rgb(entry.background), result), [0, 0, 0, 0])
  assert.equal(background[3], 1, 'The popup must resolve to an opaque adjacent surface')
  const levels = [luminance(outline), luminance(background)].sort((a, b) => b - a)
  const contrast = (levels[0] + 0.05) / (levels[1] + 0.05)
  assert.ok(
    contrast >= 3,
    `Reasoning focus contrast ${contrast.toFixed(2)} is below 3:1: ${JSON.stringify(metrics)}`
  )
}

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
  await assertReasoningKeyboardFocus(TRACK)
  await control.command('nativePress', TRACK, { key: 'Tab' })
  const firstStep = `${TRACK} > button:first-of-type`
  await assertReasoningKeyboardFocus(firstStep)
  await control.command('nativePress', firstStep, { key: 'Escape' })
  await control.command('waitFor', MENU, { visible: false })
  assert.equal(await control.command('getActiveElementTestId', 'body'), 'model-selector-button')
}
