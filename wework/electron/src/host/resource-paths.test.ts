import { describe, expect, test } from 'vitest'
import { electronResourceRoot } from './resource-paths.js'

describe('electronResourceRoot', () => {
  test('uses packaged resources for a packaged application', () => {
    expect(
      electronResourceRoot({
        isPackaged: true,
        packageRoot: '/workspace/wework/electron',
        processResourcesPath: '/Applications/WeWork.app/Contents/Resources',
      })
    ).toBe('/Applications/WeWork.app/Contents/Resources')
  })

  test('uses shared Wework resources during development', () => {
    expect(
      electronResourceRoot({
        isPackaged: false,
        packageRoot: '/workspace/wework/electron',
        processResourcesPath: '/unused',
      })
    ).toBe('/workspace/wework/resources')
  })
})
