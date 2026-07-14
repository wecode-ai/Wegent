import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { TOGGLE_MODEL_SELECTOR_COMMAND, setActiveKeybindings } from '@/lib/keybindings'
import { useConfiguredKeybinding } from './useConfiguredKeybinding'

describe('useConfiguredKeybinding', () => {
  afterEach(() => {
    setActiveKeybindings([])
  })

  test('tracks customized and cleared bindings', () => {
    const { result } = renderHook(() => useConfiguredKeybinding(TOGGLE_MODEL_SELECTOR_COMMAND))
    expect(result.current).toBe('Control+Shift+M')

    act(() => {
      setActiveKeybindings([{ command: TOGGLE_MODEL_SELECTOR_COMMAND, key: 'Control+M' }])
    })
    expect(result.current).toBe('Control+M')

    act(() => {
      setActiveKeybindings([{ command: TOGGLE_MODEL_SELECTOR_COMMAND, key: null }])
    })
    expect(result.current).toBeNull()
  })
})
