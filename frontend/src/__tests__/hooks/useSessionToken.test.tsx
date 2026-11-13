// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'
import { getSessionTokenSnapshot, removeToken, setToken } from '@/apis/user'
import { useSessionToken } from '@/hooks/useSessionToken'

jest.mock('@/apis/client', () => ({ apiClient: {} }))

describe('useSessionToken', () => {
  beforeEach(() => {
    localStorage.clear()
    removeToken()
  })

  afterEach(() => {
    removeToken()
    jest.restoreAllMocks()
  })

  it('observes same-tab login, account changes and logout without a parent render', () => {
    const { result } = renderHook(() => useSessionToken())
    expect(result.current).toBeNull()
    act(() => setToken('first-session'))
    expect(result.current).toBe('first-session')
    act(() => setToken('second-session'))
    expect(result.current).toBe('second-session')
    act(() => removeToken())
    expect(result.current).toBeNull()
  })

  it.each(['account', 'logout', 'clear'])('observes cross-tab session %s', change => {
    setToken('first-session')
    const { result } = renderHook(() => useSessionToken())
    act(() => {
      if (change === 'account') localStorage.setItem('auth_token', 'second-session')
      else if (change === 'clear') localStorage.clear()
      else localStorage.removeItem('auth_token')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: change === 'clear' ? null : 'auth_token',
          storageArea: localStorage,
        })
      )
    })
    expect(result.current).toBe(change === 'account' ? 'second-session' : null)
  })

  it('ignores unrelated local storage and session storage events', () => {
    setToken('first-session')
    const { result } = renderHook(() => useSessionToken())
    act(() => {
      localStorage.setItem('auth_token', 'second-session')
      window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }))
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'auth_token', storageArea: sessionStorage })
      )
    })
    expect(result.current).toBe('first-session')
    act(() => window.dispatchEvent(new Event('focus')))
    expect(result.current).toBe('second-session')
  })

  it('reads snapshots without restoring a cookie during rendering', () => {
    localStorage.setItem('auth_token', 'stored-session')
    expect(getSessionTokenSnapshot()).toBe('stored-session')
    renderHook(() => useSessionToken())
    expect(document.cookie).not.toContain('auth_token=')
  })

  it('removes every listener on unmount', () => {
    const add = jest.spyOn(window, 'addEventListener')
    const remove = jest.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useSessionToken())
    const subscriptions = add.mock.calls.filter(([name]) =>
      ['storage', 'wegent:session-token-changed', 'focus'].includes(name)
    )
    expect(subscriptions).toHaveLength(3)
    unmount()
    for (const [name, listener] of subscriptions) {
      expect(remove).toHaveBeenCalledWith(name, listener)
    }
  })
})
