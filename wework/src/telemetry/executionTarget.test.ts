import { describe, expect, test } from 'vitest'
import { telemetryExecutionTarget } from './executionTarget'

describe('telemetryExecutionTarget', () => {
  test.each([
    ['local', 'local'],
    ['app', 'local'],
    ['cloud', 'cloud'],
    ['remote', 'remote'],
  ] as const)('maps a %s device to %s', (deviceType, expected) => {
    expect(
      telemetryExecutionTarget('device-1', [
        {
          device_id: 'device-1',
          device_type: deviceType,
        },
      ])
    ).toBe(expected)
  })

  test('keeps the local device alias local when device metadata is unavailable', () => {
    expect(telemetryExecutionTarget('local-device', [])).toBe('local')
  })

  test('uses unknown for an unrecognized or unavailable device', () => {
    expect(
      telemetryExecutionTarget('device-1', [
        {
          device_id: 'device-1',
          device_type: 'future-device-type',
        },
      ])
    ).toBe('unknown')
    expect(telemetryExecutionTarget('missing-device', [])).toBe('unknown')
  })
})
