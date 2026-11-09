import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  getImNotificationPresenceClientId,
  useAwayImNotificationPresence,
} from './awayImNotificationPresence'

const focusState = vi.hoisted(() => ({
  focused: true,
  listener: null as ((focused: boolean) => void) | null,
}))

const lockState = vi.hoisted(() => ({
  locked: false,
  listener: null as ((locked: boolean) => void) | null,
}))

vi.mock('@/desktop/windowFocus', () => ({
  isMainWindowFocused: () => focusState.focused,
  subscribeMainWindowFocus: (listener: (focused: boolean) => void) => {
    focusState.listener = listener
    return () => {
      focusState.listener = null
    }
  },
}))

vi.mock('@/desktop/systemLock', () => ({
  isSystemSessionLocked: () => lockState.locked,
  subscribeSystemSessionLock: (listener: (locked: boolean) => void) => {
    lockState.listener = listener
    return () => {
      lockState.listener = null
    }
  },
}))

describe('away IM notification presence', () => {
  beforeEach(() => {
    localStorage.clear()
    focusState.focused = true
    focusState.listener = null
    lockState.locked = false
    lockState.listener = null
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('keeps one stable installation client id', () => {
    expect(getImNotificationPresenceClientId()).toBe(getImNotificationPresenceClientId())
  })

  test('reports foreground initially and away after focus is lost', async () => {
    const updatePresence = vi.fn().mockResolvedValue({ away: false, ttlSeconds: 90 })
    renderHook(() =>
      useAwayImNotificationPresence({
        enabled: true,
        updatePresence,
      })
    )

    await waitFor(() => expect(updatePresence).toHaveBeenCalledTimes(1))
    expect(updatePresence.mock.calls[0][0]).toMatchObject({ away: false })

    act(() => {
      focusState.listener?.(false)
    })

    await waitFor(() => expect(updatePresence).toHaveBeenCalledTimes(2))
    expect(updatePresence.mock.calls[1][0]).toMatchObject({ away: true })
  })
})
