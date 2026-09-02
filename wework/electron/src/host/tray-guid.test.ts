import { describe, expect, test } from 'vitest'
import { trayGuidForApplicationId } from './tray-guid.js'

describe('trayGuidForApplicationId', () => {
  test('preserves the released Wework tray identity', () => {
    expect(trayGuidForApplicationId('io.wecode.wework')).toBe(
      'b3dce801-ead2-5b83-bc0a-7be0b543c833'
    )
  })

  test('isolates tray identities for branded and debug applications', () => {
    expect(trayGuidForApplicationId('io.wecode.wework')).not.toBe(
      trayGuidForApplicationId('com.example.workbench')
    )
  })
})
