import assert from 'node:assert/strict'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'
import { withProjectRenderer } from './project-create-test-utils.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

function rgb(color) {
  assert.match(
    color,
    /^(?:rgba?\(|color\(srgb\s)/,
    `Expected a computed sRGB color, received ${color}`
  )
  const values = color.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? []
  assert.ok(values.length === 3 || values.length === 4, `Invalid computed color: ${color}`)
  const scale = color.startsWith('color(') ? 255 : 1
  return [...values.slice(0, 3).map(channel => channel * scale), values[3] ?? 1]
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

export function assertFocusIndicatorMetrics(metrics, { checkClipping = false } = {}) {
  assert.ok(metrics?.focused, 'The control must hold visible keyboard focus')
  assert.equal(metrics.style, 'solid')
  assert.ok(metrics.width >= 2)
  assert.ok(metrics.layers.every(layer => layer.opacity === 1))
  const outline = rgb(metrics.outline)
  assert.equal(outline[3], 1, 'The focus outline must be opaque')
  // Include the control's own background: inset outlines sit inside its focused row.
  const background = metrics.layers
    .toReversed()
    .reduce((result, layer) => composite(rgb(layer.background), result), [0, 0, 0, 0])
  assert.equal(background[3], 1, 'The adjacent surface must resolve to an opaque color')
  const levels = [luminance(outline), luminance(background)].sort((a, b) => b - a)
  const contrast = (levels[0] + 0.05) / (levels[1] + 0.05)
  assert.ok(
    contrast >= 3,
    `Focus contrast ${contrast.toFixed(2)} is below 3:1: ${JSON.stringify(metrics)}`
  )
  if (checkClipping) {
    const extent = Math.max(0, metrics.offset + metrics.width)
    for (const clip of metrics.clips) {
      assert.ok(
        !clip.x ||
          (metrics.rect.left - extent >= clip.left - 0.5 &&
            metrics.rect.right + extent <= clip.right + 0.5),
        `The focus outline is clipped horizontally: ${JSON.stringify(metrics)}`
      )
      assert.ok(
        !clip.y ||
          (metrics.rect.top - extent >= clip.top - 0.5 &&
            metrics.rect.bottom + extent <= clip.bottom + 0.5),
        `The focus outline is clipped vertically: ${JSON.stringify(metrics)}`
      )
    }
  }
}

function readFocusMetrics(selector, focusSelector) {
  return withProjectRenderer(async (client, target) => {
    const value = await client({
      action: 'command',
      target,
      method: 'Runtime.evaluate',
      params: {
        returnByValue: true,
        expression: `(() => {
        const element = document.querySelector(${JSON.stringify(selector)})
        if (!element) return null
        const focusTarget = document.querySelector(${JSON.stringify(focusSelector)})
        const style = getComputedStyle(element)
        const layers = [], clips = [{ x: true, y: true, left: 0, top: 0, right: innerWidth, bottom: innerHeight }]
        let settled = true
        for (let node = element; node; node = node.parentElement) {
          const current = getComputedStyle(node), rect = node.getBoundingClientRect()
          layers.push({ background: current.backgroundColor, opacity: Number(current.opacity) })
          if (node.getAnimations().some(animation => animation.playState === 'running' || animation.pending)) settled = false
          if (node !== element) clips.push({ x: current.overflowX !== 'visible', y: current.overflowY !== 'visible',
            left: rect.left + node.clientLeft, top: rect.top + node.clientTop,
            right: rect.left + node.clientLeft + node.clientWidth, bottom: rect.top + node.clientTop + node.clientHeight })
        }
        return { focused: document.activeElement === focusTarget && focusTarget?.matches(':focus-visible'),
          outline: style.outlineColor, width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset),
          style: style.outlineStyle, layers, settled, clips, rect: element.getBoundingClientRect().toJSON() }
      })()`,
      },
    })
    return value.result?.value
  })
}

export async function assertProjectKeyboardFocus(selector, { focusSelector = selector, ...options } = {}) {
  const metrics = await waitForValue(
    () => readFocusMetrics(selector, focusSelector),
    value => value?.settled && value.layers.every(layer => layer.opacity === 1),
    'The model popup did not finish its transitions before focus verification',
    DEFAULT_STEP_TIMEOUT_MS
  )
  assertFocusIndicatorMetrics(metrics, options)
}
