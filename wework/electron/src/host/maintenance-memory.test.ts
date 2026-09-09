import { describe, expect, test } from 'vitest'
import { availableMemoryRatio } from './maintenance-memory.js'

describe('maintenance memory pressure', () => {
  const memory = { total: 1000, free: 9, available: 450, fileBacked: 300 }

  test('allows idle work on macOS when file cache occupies otherwise available memory', () => {
    expect(availableMemoryRatio(memory, 'darwin')).toBe(0.309)
  })

  test('uses the kernel available-memory estimate on Linux', () => {
    expect(availableMemoryRatio(memory, 'linux')).toBe(0.45)
  })

  test('preserves real memory pressure and bounds invalid totals', () => {
    expect(availableMemoryRatio({ ...memory, fileBacked: 0 }, 'darwin')).toBe(0.009)
    expect(availableMemoryRatio(memory, 'win32')).toBe(0.009)
    expect(availableMemoryRatio({ ...memory, total: 0 }, 'darwin')).toBe(0)
  })
})
