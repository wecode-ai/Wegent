// @vitest-environment jsdom
import { expect, test, vi } from 'vitest'
import { getElementMotionDiagnostics } from './element-motion-diagnostics'

test('retains closing state and paused motion without copying private DOM data', () => {
  const element = document.createElement('div')
  element.innerHTML =
    '<div data-dismissing="true" data-has-conversation="false" data-token="private-token"><input value="private-input">private-body</div>'
  element.getAnimations = vi.fn(() => [
    { playState: 'paused', pending: true, currentTime: 12 } as Animation,
  ])
  const snapshot = getElementMotionDiagnostics(element)
  expect(snapshot.animations).toEqual([{ playState: 'paused', pending: true, currentTime: 12 }])
  expect(snapshot.states).toEqual([
    { tag: 'DIV', flags: { 'data-dismissing': true, 'data-has-conversation': false } },
  ])
  expect(JSON.stringify(snapshot)).not.toMatch(/private|token|input/i)
  expect(element.getAnimations).toHaveBeenCalledWith({ subtree: true })
})

test('distinguishes missing motion instrumentation from an observed empty animation list', () => {
  const element = document.createElement('div')
  expect(getElementMotionDiagnostics(element).animations).toBeNull()
  element.getAnimations = vi.fn(() => [])
  expect(getElementMotionDiagnostics(element).animations).toEqual([])
  element.getAnimations = vi.fn(() => {
    throw new Error('private native failure')
  })
  const snapshot = getElementMotionDiagnostics(element)
  expect(snapshot.animations).toBeNull()
  expect(JSON.stringify(snapshot)).not.toContain('private')
})

test('bounds DOM inspection and animation output while preserving omitted counts', () => {
  const element = document.createElement('div')
  for (let index = 0; index < 200; index++) {
    const child = document.createElement('div')
    child.dataset.open = 'true'
    element.append(child)
  }
  element.getAnimations = vi.fn(() =>
    Array.from(
      { length: 30 },
      () =>
        ({
          playState: 'running',
          pending: false,
          currentTime: NaN,
        }) as Animation
    )
  )
  const snapshot = getElementMotionDiagnostics(element)
  expect(snapshot.unscannedElements).toBe(72)
  expect(snapshot.states).toHaveLength(16)
  expect(snapshot.omittedStates).toBe(112)
  expect(snapshot.animations).toHaveLength(16)
  expect(snapshot.omittedAnimations).toBe(14)
  expect(snapshot.animations?.[0].currentTime).toBeNull()
})

test('does not serialize opaque animation values', () => {
  const element = document.createElement('div')
  element.getAnimations = vi.fn(() => [
    {
      playState: 'private-state',
      pending: 'private-value',
      currentTime: { token: 'private-token' },
    } as unknown as Animation,
  ])
  const snapshot = getElementMotionDiagnostics(element)
  expect(snapshot.animations).toEqual([{ playState: 'unknown', pending: null, currentTime: null }])
  expect(JSON.stringify(snapshot)).not.toContain('private')
})
