import { fireEvent, renderHook } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { getPlatform } from '@/lib/platform'
import { useRightWorkspaceShortcuts } from './useRightWorkspaceShortcuts'

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
  const shortcuts = [
    { key: '®', code: 'KeyR', action: 'onSelectReview', capability: 'canOpenReview' },
    { key: 'ß', code: 'KeyS', action: 'onSelectChat', capability: 'allowTemporaryChat' },
    { key: 'ƒ', code: 'KeyF', action: 'onSelectFiles', capability: 'canBrowseFiles' },
  ] as const

  test.each(shortcuts)(
    'opens $action from the composer without a mounted panel',
    ({ key, code, action }) => {
      const { options } = renderShortcuts()
      const composer = document.createElement('textarea')
      composer.dataset.testid = 'chat-message-input'
      document.body.appendChild(composer)
      try {
        expect(fireEvent.keyDown(composer, { key, code, metaKey: true, altKey: true })).toBe(false)
        expect(options[action]).toHaveBeenCalledOnce()
      } finally {
        composer.remove()
      }
    }
  )

  test.each(
    (['win', 'linux'] as const).flatMap(platform =>
      shortcuts.map(shortcut => ({ platform, ...shortcut }))
    )
  )('opens $action on $platform', ({ platform, code, action }) => {
    vi.mocked(getPlatform).mockReturnValueOnce(platform)
    const { options } = renderShortcuts()
    fireEvent.keyDown(window, {
      key: code.slice(-1).toLowerCase(),
      code,
      ctrlKey: true,
      altKey: true,
    })
    expect(options[action]).toHaveBeenCalledOnce()
  })

  test.each(['input', 'textarea', 'contenteditable'])(
    'opens files from an active workbench %s',
    kind => {
      const { options } = renderShortcuts()
      const workbench = document.createElement('section')
      workbench.dataset.activeWorkbenchPane = 'true'
      const input = document.createElement(kind === 'contenteditable' ? 'div' : kind)
      if (kind === 'contenteditable') {
        Object.defineProperty(input, 'isContentEditable', { value: true })
      }
      workbench.appendChild(input)
      document.body.appendChild(workbench)
      try {
        expect(
          fireEvent.keyDown(input, {
            key: 'ƒ',
            code: 'KeyF',
            metaKey: true,
            altKey: true,
          })
        ).toBe(false)
        expect(options.onSelectFiles).toHaveBeenCalledOnce()
      } finally {
        workbench.remove()
      }
    }
  )

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

  test.each([
    { altKey: true },
    { metaKey: true },
    { metaKey: true, altKey: true, shiftKey: true },
    { metaKey: true, altKey: true, ctrlKey: true },
    { metaKey: true, altKey: true, isComposing: true },
  ])('ignores unrelated combinations: %j', modifiers => {
    const { options } = renderShortcuts()
    fireEvent.keyDown(window, { key: 'ß', code: 'KeyS', ...modifiers })
    expect(options.onSelectChat).not.toHaveBeenCalled()
  })

  test('handles shortcuts only in the active conversation and removes the listener', () => {
    const active = renderShortcuts()
    const inactive = renderShortcuts({ active: false })
    const shortcut = { key: 'ß', code: 'KeyS', metaKey: true, altKey: true }
    fireEvent.keyDown(window, shortcut)
    expect(active.options.onSelectChat).toHaveBeenCalledOnce()
    expect(inactive.options.onSelectChat).not.toHaveBeenCalled()

    active.rerender({ ...active.options, active: false })
    inactive.rerender({ ...inactive.options, active: true })
    fireEvent.keyDown(window, shortcut)
    expect(active.options.onSelectChat).toHaveBeenCalledOnce()
    expect(inactive.options.onSelectChat).toHaveBeenCalledOnce()

    inactive.unmount()
    fireEvent.keyDown(window, shortcut)
    expect(inactive.options.onSelectChat).toHaveBeenCalledOnce()
  })

  test('keeps other editors and already handled events untouched', () => {
    const { options } = renderShortcuts()
    const shortcut = { key: 'ß', code: 'KeyS', metaKey: true, altKey: true }
    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      fireEvent.keyDown(input, shortcut)
      const handled = new KeyboardEvent('keydown', { ...shortcut, cancelable: true })
      handled.preventDefault()
      window.dispatchEvent(handled)
      expect(options.onSelectChat).not.toHaveBeenCalled()
    } finally {
      input.remove()
    }
  })

  test.each(['mac', 'win', 'linux'] as const)(
    'opens the browser with the displayed primary+T shortcut on %s',
    platform => {
      vi.mocked(getPlatform).mockReturnValueOnce(platform)
      const { options } = renderShortcuts()
      fireEvent.keyDown(window, {
        key: 't',
        code: 'KeyT',
        metaKey: platform === 'mac',
        ctrlKey: platform !== 'mac',
      })
      expect(options.onSelectBrowser).toHaveBeenCalledOnce()
    }
  )

  test.each(shortcuts)(
    'leaves Command shortcuts unhandled on Linux: $action',
    ({ code, action }) => {
      vi.mocked(getPlatform).mockReturnValueOnce('linux')
      const { options } = renderShortcuts()
      expect(
        fireEvent.keyDown(window, {
          key: code.slice(-1).toLowerCase(),
          code,
          metaKey: true,
          altKey: true,
        })
      ).toBe(true)
      expect(options[action]).not.toHaveBeenCalled()
    }
  )

  test.each([
    { key: 'a', code: 'KeyA' },
    { key: 'Enter', code: 'Enter' },
    { key: 'a', code: 'KeyA', metaKey: true },
    { key: 'c', code: 'KeyC', metaKey: true },
    { key: 'v', code: 'KeyV', metaKey: true },
    { key: 'z', code: 'KeyZ', metaKey: true },
    { key: 's', code: 'KeyS', metaKey: true },
    { key: 'f', code: 'KeyF', metaKey: true },
    { key: 'b', code: 'KeyB', metaKey: true },
    { key: 'j', code: 'KeyJ', metaKey: true },
    { key: 'm', code: 'KeyM', ctrlKey: true, shiftKey: true },
  ])('preserves editing and other workbench keys: %j', shortcut => {
    const { options } = renderShortcuts()
    const workbench = document.createElement('section')
    workbench.dataset.activeWorkbenchPane = 'true'
    const editor = document.createElement('textarea')
    workbench.appendChild(editor)
    document.body.appendChild(workbench)
    try {
      expect(fireEvent.keyDown(editor, shortcut)).toBe(true)
      expect(options.onNavigate).not.toHaveBeenCalled()
    } finally {
      workbench.remove()
    }
  })
})
