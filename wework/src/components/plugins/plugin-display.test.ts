import { describe, expect, test } from 'vitest'
import { formatPluginVersion } from './plugin-display'

describe('formatPluginVersion', () => {
  test('removes repository revision suffixes without changing semantic prereleases', () => {
    expect(formatPluginVersion('0.2.8-13ceeea1f599')).toBe('0.2.8')
    expect(formatPluginVersion('1.0.0-beta.1')).toBe('1.0.0-beta.1')
  })
})
