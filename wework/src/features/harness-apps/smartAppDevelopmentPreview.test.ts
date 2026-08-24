import { beforeEach, describe, expect, test } from 'vitest'
import {
  consumeSmartAppDevelopmentPreview,
  queueSmartAppDevelopmentPreview,
} from './smartAppDevelopmentPreview'

describe('smartAppDevelopmentPreview', () => {
  beforeEach(() => window.sessionStorage.clear())

  test('queues one development preview for the next workbench', () => {
    queueSmartAppDevelopmentPreview({
      installationId: 'blank-workbench',
      displayName: '空白工作台',
    })

    expect(consumeSmartAppDevelopmentPreview()).toEqual({
      installationId: 'blank-workbench',
      displayName: '空白工作台',
    })
    expect(consumeSmartAppDevelopmentPreview()).toBeNull()
  })

  test('discards invalid stored data', () => {
    window.sessionStorage.setItem(
      'wework:pending-smart-app-development-preview',
      JSON.stringify({ installationId: '' })
    )

    expect(consumeSmartAppDevelopmentPreview()).toBeNull()
  })
})
