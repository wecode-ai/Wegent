import { describe, expect, test } from 'vitest'
import { availableMemoryRatio } from './maintenance-memory.js'

describe('maintenance memory pressure', () => {
  const memory = { total: 1000, free: 9, fileBacked: 300 }
  const availableMemoryBytes = 450 * 1024

  test('allows idle work on macOS when file cache occupies otherwise available memory', () => {
    expect(availableMemoryRatio(memory, 'darwin', availableMemoryBytes)).toBe(0.309)
  })

  test('uses the kernel available-memory estimate on Linux', () => {
    expect(availableMemoryRatio(memory, 'linux', availableMemoryBytes)).toBe(0.45)
    expect(availableMemoryRatio(memory, 'linux', 0)).toBe(0)
  })

  test('preserves real memory pressure and bounds invalid totals', () => {
    expect(availableMemoryRatio({ ...memory, fileBacked: 0 }, 'darwin', availableMemoryBytes)).toBe(
      0.009
    )
    expect(availableMemoryRatio(memory, 'win32', availableMemoryBytes)).toBe(0.009)
    expect(availableMemoryRatio({ ...memory, total: 0 }, 'darwin', availableMemoryBytes)).toBe(0)
    expect(availableMemoryRatio(memory, 'linux', 2000 * 1024)).toBe(1)
    expect(availableMemoryRatio(memory, 'linux', -1)).toBe(0)
  })
})
