import { beforeEach, describe, expect, test } from 'vitest'
import { getDesktopE2EClipboardText, installDesktopE2EClipboard } from './clipboard'

describe('desktop E2E clipboard', () => {
  beforeEach(() => {
    installDesktopE2EClipboard()
  })

  test('records copied text without requiring an operating-system clipboard', async () => {
    await navigator.clipboard.writeText('docker run')

    expect(getDesktopE2EClipboardText()).toBe('docker run')
  })
})
