import { beforeEach, describe, expect, test, vi } from 'vitest'

const invokeDesktopHost = vi.hoisted(() => vi.fn())

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost }))

import { takeHarnessAppAdditionalProxyTokens } from './harnessAppTabs'

describe('harnessAppTabs', () => {
  beforeEach(() => {
    invokeDesktopHost.mockReset()
  })

  test('defaults additional proxy tokens to an empty list when the host returns none', async () => {
    invokeDesktopHost.mockResolvedValue(undefined)

    await expect(takeHarnessAppAdditionalProxyTokens('smart-app')).resolves.toEqual([])
  })
})
