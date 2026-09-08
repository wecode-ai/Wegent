import { describe, expect, test } from 'vitest'
import { trayGuidForApplicationId } from './tray-guid.js'

describe('trayGuidForApplicationId', () => {
  test('preserves the released Wework tray identity', () => {
    expect(trayGuidForApplicationId('io.wecode.wework')).toBe(
      '8fda9369-51a7-5cd6-9625-cb1b65f440db'
    )
  })

  test('generates stable isolated tray identities for branded and debug applications', () => {
    const brandedGuid = trayGuidForApplicationId('com.example.workbench')

    expect(brandedGuid).toBe(trayGuidForApplicationId('com.example.workbench'))
    expect(brandedGuid).not.toBe(trayGuidForApplicationId('io.wecode.wework'))
    expect(brandedGuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })
})
