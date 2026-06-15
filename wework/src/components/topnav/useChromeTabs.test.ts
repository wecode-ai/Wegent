import { renderHook } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { useChromeTabs } from './useChromeTabs'

describe('useChromeTabs', () => {
  test('shows the app center as a fixed titlebar tab', () => {
    const { result } = renderHook(() => useChromeTabs('/apps'))

    expect(result.current.tabs.map(tab => tab.key)).toEqual(['wework', 'apps'])
    expect(result.current.activeAppKey).toBe('apps')
    expect(result.current.activeTab?.label).toBe('应用')
  })

  test('hides Wegent from the titlebar without removing route resolution', () => {
    const { result } = renderHook(() => useChromeTabs('/app/wegent'))

    expect(result.current.tabs.map(tab => tab.key)).toEqual(['wework', 'apps'])
    expect(result.current.activeAppKey).toBe('wegent')
    expect(result.current.activeTab?.key).toBe('wegent')
  })
})
