import assert from 'node:assert/strict'
import { colorChannels, focusLayers, readFocusPaint } from './focus-paint.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'
import { withProjectRenderer } from './project-create-test-utils.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

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
  const outline = colorChannels(metrics.outline)
  assert.equal(outline[3], 1, 'The focus outline must be opaque')
  // Include the control's own background: inset outlines sit inside its focused row.
  const background = metrics.layers
    .toReversed()
    .reduce((result, layer) => composite(colorChannels(layer.background), result), [0, 0, 0, 0])
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

export async function assertProjectKeyboardFocus(
  selector,
  { focusSelector = selector, ...options } = {}
) {
  const metrics = await waitForValue(
    () => readFocusMetrics(selector, focusSelector),
    value => value?.settled && value.layers.every(layer => layer.opacity === 1),
    'The model popup did not finish its transitions before focus verification',
    DEFAULT_STEP_TIMEOUT_MS
  )
  assertFocusIndicatorMetrics(metrics, options)
}

// The renderer keeps the actual field, parent and button instances throughout the interaction.
function observeField(field, includeParent, previousId, nextPattern, paint) {
  const surfaces = includeParent ? [field, field.parentElement] : [field]
  const normalButtonPaint = new WeakMap()
  return async (captureButtons = false) => {
    if (!field.isConnected || (includeParent && field.parentElement !== surfaces[1])) {
      throw new Error('The field was replaced during focus verification')
    }
    const windowFocusedBefore = document.hasFocus()
    const active = document.activeElement
    const buttons =
      captureButtons && (previousId || nextPattern)
        ? Array.from(
            document.querySelectorAll('button[data-testid], [role="button"][data-testid]')
          ).filter(
            button =>
              button !== active &&
              (button.dataset.testid === previousId || nextPattern?.test(button.dataset.testid))
          )
        : []
    const observed = new Set([...surfaces, active, ...buttons])
    await Promise.allSettled(
      Array.from(observed).flatMap(node =>
        node
          .getAnimations()
          .filter(
            a =>
              (a.pending || a.playState === 'running') &&
              a.effect?.getTiming().iterations !== Infinity
          )
          .map(a => a.finished)
      )
    )
    if (document.activeElement !== active)
      throw new Error('Focus moved while measuring the control')
    for (const button of buttons) normalButtonPaint.set(button, paint(button))
    const rect = field.getBoundingClientRect(),
      x = rect.left + rect.width / 2,
      y = rect.top + rect.height / 2
    return {
      x,
      y,
      hit: field.contains(document.elementFromPoint(x, y)),
      id: active.dataset.testid,
      fieldFocused: active === field,
      windowFocusedBefore,
      windowFocused: document.hasFocus(),
      activeFocusVisible: active.matches(':focus-visible'),
      fieldFocusVisible: field.matches(':focus-visible'),
      modality: document.documentElement.dataset.inputModality,
      surfaces: surfaces.map(paint),
      border: getComputedStyle(surfaces.at(-1)).borderColor,
      active: paint(active),
      inactiveButton: normalButtonPaint.get(active),
    }
  }
}

export async function verifyProjectFieldFocus(
  control,
  fieldId,
  { includeParent = false, scope = '', previousButtonId, nextButtonPattern } = {}
) {
  const field = `${scope} [data-testid="${fieldId}"]`.trim()
  await control.command('waitFor', field, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  await control.command('scrollIntoView', field)
  await control.command('waitFor', field, { visible: true, timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  return withProjectRenderer(async (client, target) => {
    const command = (method, params) => client({ action: 'command', target, method, params })
    await control.command('focusMainWindow', 'body')
    const observer = await command('Runtime.evaluate', {
      expression: `(${observeField.toString()})(document.querySelector(${JSON.stringify(field)}),
        ${includeParent}, ${JSON.stringify(previousButtonId)}, ${nextButtonPattern ?? 'null'}, ${readFocusPaint.toString()})`,
    })
    assert.ok(!observer.exceptionDetails, observer.exceptionDetails?.exception?.description)
    assert.ok(observer.result.objectId, 'Expected a renderer observer for the field')
    const readings = []
    const readPaint = async (captureButtons = false) => {
      const response = await command('Runtime.callFunctionOn', {
        objectId: observer.result.objectId,
        functionDeclaration: 'function (capture) { return this(capture) }',
        arguments: [{ value: captureButtons }],
        awaitPromise: true,
        returnByValue: true,
      })
      assert.ok(!response.exceptionDetails, response.exceptionDetails?.exception?.description)
      const state = response.result.value
      readings.push(state)
      assert.ok(
        state.windowFocusedBefore && state.windowFocused,
        `The Electron window lost focus while measuring ${fieldId}`
      )
      return state
    }
    const count = (state, baseline) =>
      state.surfaces.reduce(
        (n, surface, index) => n + focusLayers(surface, baseline.surfaces[index]),
        0
      )
    try {
      const point = await readPaint()
      assert.ok(point.hit, `The pointer must be able to reach ${fieldId}`)
      for (const type of ['mousePressed', 'mouseReleased']) {
        await command('Input.dispatchMouseEvent', {
          type,
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1,
        })
      }
      const pointer = await readPaint(true)
      assert.equal(pointer.fieldFocused, true, fieldId)
      assert.equal(pointer.id, fieldId)
      assert.equal(pointer.modality, 'pointer')
      await control.command('nativePress', field, { key: previousButtonId ? 'Shift+Tab' : 'Tab' })
      const away = await readPaint()
      assert.equal(away.fieldFocused, false)
      assert.equal(
        count(pointer, away),
        0,
        `Clicking ${fieldId} must retain its neutral focus style`
      )
      assert.equal(
        pointer.border,
        away.border,
        'Pointer focus must retain the ordinary field border'
      )
      if (previousButtonId) {
        assert.equal(away.id, previousButtonId)
        assert.ok(away.activeFocusVisible, `Native Tab must visibly focus ${previousButtonId}`)
        assert.equal(
          focusLayers(away.active, away.inactiveButton),
          1,
          `Keyboard focus must be visible once on ${previousButtonId}`
        )
      }
      await control.command('nativePress', ':focus', {
        key: previousButtonId ? 'Tab' : 'Shift+Tab',
      })
      const keyboard = await readPaint()
      assert.equal(keyboard.fieldFocused, true, fieldId)
      assert.equal(keyboard.id, fieldId)
      assert.ok(keyboard.activeFocusVisible, `Native Tab must visibly focus ${fieldId}`)
      assert.equal(keyboard.modality, 'keyboard')
      assert.equal(count(keyboard, away), 1, `Keyboard focus must be visible once on ${fieldId}`)
      if (nextButtonPattern) {
        await control.command('nativePress', field, { key: 'Tab' })
        const next = await readPaint()
        assert.match(next.id, nextButtonPattern)
        assert.ok(next.activeFocusVisible, `Native Tab must visibly focus ${next.id}`)
        assert.equal(
          focusLayers(next.active, next.inactiveButton),
          1,
          `Keyboard focus must be visible once on ${next.id}`
        )
      }
      return { keyboardBorder: keyboard.border, unfocusedBorder: away.border }
    } catch (error) {
      throw new Error(`${error.message}\nFocus measurements: ${JSON.stringify(readings)}`, {
        cause: error,
      })
    } finally {
      await command('Runtime.releaseObject', { objectId: observer.result.objectId })
    }
  })
}
