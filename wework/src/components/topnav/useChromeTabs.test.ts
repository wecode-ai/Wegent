import { renderHook } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { useChromeTabs } from './useChromeTabs'

describe('useChromeTabs', () => {
  test('hides Wegent from the titlebar without removing route resolution', () => {
    const { result } = renderHook(() => useChromeTabs('/app/wegent'))

    expect(result.current.tabs.map(tab => tab.key)).toEqual(['wework'])
    expect(result.current.activeAppKey).toBe('wegent')
    expect(result.current.activeTab?.key).toBe('wegent')
  })
})
