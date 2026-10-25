import { expect, test } from 'vitest'
import {
  createNativeKeyObservation,
  readNativeTerminalViewport,
  registerNativeTerminalViewport,
} from './native-key-observation'

test('samples the value when the trusted key arrives, before the key changes the viewport', () => {
  const target = new EventTarget()
  let row = '321'
  const observation = createNativeKeyObservation(target, () => row)
  row = '389'
  observation.record({ isTrusted: true, target })
  row = '345'
  expect(observation.result()).toBe('389')
})

test('rejects synthetic keys and keys sent to another target', () => {
  const target = new EventTarget()
  const observation = createNativeKeyObservation(target, () => '389')
  observation.record({ isTrusted: false, target })
  observation.record({ isTrusted: true, target: new EventTarget() })
  expect(() => observation.result()).toThrow('unavailable')
})

test('reads the native buffer at key dispatch while accessibility attributes are stale', () => {
  const viewport = document.createElement('div')
  viewport.setAttribute('aria-posinset', '170')
  let nativePosition = 270
  const dispose = registerNativeTerminalViewport(viewport, () => nativePosition)
  const target = new EventTarget()
  const observation = createNativeKeyObservation(target, () => readNativeTerminalViewport(viewport))
  observation.record({ isTrusted: true, target })
  nativePosition = 226
  expect(observation.result()).toBe('270')
  expect(readNativeTerminalViewport(viewport)).toBe('226')
  expect(viewport.getAttribute('aria-posinset')).toBe('170')
  dispose()
  expect(() => readNativeTerminalViewport(viewport)).toThrow('unavailable')
})
