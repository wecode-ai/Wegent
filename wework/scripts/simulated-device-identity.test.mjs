import { expect, test } from 'vitest'
import { simulatedDeviceApplicationId } from '../e2e/desktop/modules/simulated-device-identity.mjs'

const original = { applicationId: 'io.wecode.wework.e2e', originalProfile: '/device-a' }

test('restores the exact original application namespace when returning to device A', () => {
  expect(simulatedDeviceApplicationId({ ...original, profile: '/device-a' })).toBe(
    original.applicationId
  )
})

test('keeps the same namespace on repeated visits to a simulated device', () => {
  const first = simulatedDeviceApplicationId({ ...original, profile: '/device-b' })
  simulatedDeviceApplicationId({ ...original, profile: '/device-c' })
  expect(simulatedDeviceApplicationId({ ...original, profile: '/device-b' })).toBe(first)
  expect(first).not.toBe(original.applicationId)
})

test('separates both simulated profiles and application identifiers', () => {
  const first = simulatedDeviceApplicationId({ ...original, profile: '/device-b' })
  expect(simulatedDeviceApplicationId({ ...original, profile: '/device-c' })).not.toBe(first)
  expect(
    simulatedDeviceApplicationId({
      ...original,
      applicationId: 'io.wecode.other',
      profile: '/device-b',
    })
  ).not.toBe(first)
})
