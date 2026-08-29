import { describe, expect, test } from 'vitest'
import { trayGuidForApplicationId } from './tray-guid.js'

describe('trayGuidForApplicationId', () => {
  test('returns a stable UUID v5 for the same application identity', () => {
    const first = trayGuidForApplicationId('io.wecode.wework')
    const second = trayGuidForApplicationId('io.wecode.wework')

    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('isolates tray identities for branded applications', () => {
    expect(trayGuidForApplicationId('io.wecode.wework')).not.toBe(
      trayGuidForApplicationId('com.example.workbench')
    )
  })
})
