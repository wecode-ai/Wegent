import { expect, test } from 'vitest'
import { createNativeKeyAttributeObservation } from './native-key-observation'

test('samples the attribute when the trusted key arrives, before the key changes the viewport', () => {
  const target = new EventTarget()
  let row = '321'
  const observation = createNativeKeyAttributeObservation(target, () => row)
  row = '389'
  observation.record({ isTrusted: true, target })
  row = '345'
  expect(observation.result()).toBe('389')
})

test('rejects synthetic keys and keys sent to another target', () => {
  const target = new EventTarget()
  const observation = createNativeKeyAttributeObservation(target, () => '389')
  observation.record({ isTrusted: false, target })
  observation.record({ isTrusted: true, target: new EventTarget() })
  expect(() => observation.result()).toThrow('unavailable')
})
