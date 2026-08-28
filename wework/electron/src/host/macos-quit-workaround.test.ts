import { describe, expect, test } from 'vitest'
import { requiresMacosQuitWorkaround } from './macos-quit-workaround.js'

describe('requiresMacosQuitWorkaround', () => {
  test('covers physical macOS 26 releases affected by the Electron native exit hang', () => {
    expect(requiresMacosQuitWorkaround('darwin', '25.2.0')).toBe(true)
    expect(requiresMacosQuitWorkaround('darwin', '25.4.0')).toBe(true)
  })

  test('leaves fixed macOS and other platforms on the normal Electron exit path', () => {
    expect(requiresMacosQuitWorkaround('darwin', '25.5.0')).toBe(false)
    expect(requiresMacosQuitWorkaround('darwin', '24.6.0')).toBe(false)
    expect(requiresMacosQuitWorkaround('linux', '25.2.0')).toBe(false)
  })
})
