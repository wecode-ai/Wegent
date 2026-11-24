import { act } from 'react'
import { expect, it, vi } from 'vitest'
import '../../../packages/collaboration/src/test/setup'
import { openDeveloperCommandMenu } from './developerCommandMenu'

vi.mock('./runtime-environment', () => ({ isElectronRuntime: () => false }))

it('releases standalone command roots and keeps diagnostic collapse and reopen usable', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const get = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  const click = async (id: string) => {
    await act(async () => {
      get(id)!.click()
    })
  }
  try {
    await act(async () => {
      openDeveloperCommandMenu()
    })
    await vi.waitFor(() => expect(get('developer-command-open-debug-panel')).not.toBeNull())
    await click('developer-command-open-debug-panel')
    await vi.waitFor(() =>
      expect(document.getElementById('wework-developer-command-menu')).toBeNull()
    )
    await vi.waitFor(() => expect(get('debug-panel-collapse')).not.toBeNull())
    expect(document.body.hasAttribute('data-wework-debug-panel-expanded')).toBe(true)
    await click('debug-panel-collapse')
    await vi.waitFor(() => expect(get('debug-panel-collapsed')).not.toBeNull())
    expect(document.querySelector('[role="dialog"][aria-label="Debug panel"]')).toBeNull()
    expect(document.body.hasAttribute('data-wework-debug-panel-expanded')).toBe(false)
    await click('debug-panel-collapsed')
    await vi.waitFor(() => expect(get('debug-panel-close')).not.toBeNull())
    expect(document.body.hasAttribute('data-wework-debug-panel-expanded')).toBe(true)
    await click('debug-panel-close')
    await vi.waitFor(() => expect(document.getElementById('wework-debug-panel')).toBeNull())
    expect(document.body.hasAttribute('data-wework-debug-panel-expanded')).toBe(false)
    await act(async () => {
      openDeveloperCommandMenu()
    })
    await vi.waitFor(() => expect(get('developer-command-open-debug-panel')).not.toBeNull())
    const dialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Developer commands"]'
    )!
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    await vi.waitFor(() =>
      expect(document.getElementById('wework-developer-command-menu')).toBeNull()
    )
  } finally {
    if (get('debug-panel-close')) await click('debug-panel-close')
  }
})
