import { fireEvent, renderHook } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { useRightWorkspaceShortcuts } from './useRightWorkspaceShortcuts'
import { getPlatform } from '@/lib/platform'

vi.mock('@/lib/platform', () => ({ getPlatform: vi.fn(() => 'mac') }))

function renderShortcuts(overrides = {}) {
  const options = {
    active: true,
    canOpenReview: true,
    allowTemporaryChat: true,
    canBrowseFiles: true,
    onNavigate: vi.fn((action: () => void) => action()),
    onSelectReview: vi.fn(),
    onSelectBrowser: vi.fn(),
    onSelectChat: vi.fn(),
    onSelectFiles: vi.fn(),
    ...overrides,
  }
  const hook = renderHook(useRightWorkspaceShortcuts, { initialProps: options })
  return { ...hook, options }
}

describe('right workspace shortcuts', () => {
  test.each(['mac', 'win', 'linux'] as const)(
    'opens the browser with the %s primary modifier',
    platform => {
      vi.mocked(getPlatform).mockReturnValue(platform)
      const { options, unmount } = renderShortcuts()
      try {
        fireEvent.keyDown(window, {
          key: 't',
          code: 'KeyT',
          metaKey: platform === 'mac',
          ctrlKey: platform !== 'mac',
        })
        expect(options.onSelectBrowser).toHaveBeenCalledOnce()
      } finally {
        unmount()
        vi.mocked(getPlatform).mockReturnValue('mac')
      }
    }
  )
  const shortcuts = [
    { key: '®', code: 'KeyR', action: 'onSelectReview', capability: 'canOpenReview' },
    { key: 'ß', code: 'KeyS', action: 'onSelectChat', capability: 'allowTemporaryChat' },
    { key: 'ƒ', code: 'KeyF', action: 'onSelectFiles', capability: 'canBrowseFiles' },
  ] as const

  test.each(
    ['dialog', 'alertdialog', 'inactive'].flatMap(kind =>
      ['input', 'button', 'composer'].map(target => ({ kind, target }))
    )
  )('keeps file shortcuts out of a $kind $target', ({ kind, target }) => {
    const { options } = renderShortcuts()
    const workbench = document.createElement('section')
    workbench.dataset.activeWorkbenchPane = kind === 'inactive' ? 'false' : 'true'
    if (kind !== 'inactive') workbench.setAttribute('role', kind)
    const input = document.createElement(target === 'button' ? 'button' : 'input')
    if (target === 'composer') input.dataset.testid = 'chat-message-input'
    workbench.appendChild(input)
    document.body.appendChild(workbench)
    try {
      fireEvent.keyDown(input, { key: 'ƒ', code: 'KeyF', metaKey: true, altKey: true })
      expect(options.onSelectFiles).not.toHaveBeenCalled()
    } finally {
      workbench.remove()
    }
  })

  test.each(shortcuts)(
    'leaves unavailable $action unhandled',
    ({ key, code, action, capability }) => {
      const { options } = renderShortcuts({ [capability]: false })
      expect(fireEvent.keyDown(window, { key, code, metaKey: true, altKey: true })).toBe(true)
      expect(options[action]).not.toHaveBeenCalled()
    }
  )
})
