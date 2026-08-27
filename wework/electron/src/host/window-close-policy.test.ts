import { describe, expect, test, vi } from 'vitest'
import {
  WindowClosePolicy,
  initialWindowClosePolicyState,
  transitionWindowClosePolicy,
  type WindowClosePreferenceAccess,
} from './window-close-policy.js'

describe('transitionWindowClosePolicy', () => {
  test('allows the window to close while the application is quitting', () => {
    expect(
      transitionWindowClosePolicy(
        { status: 'awaiting-close-to-tray-confirmation' },
        { type: 'close-requested', quitting: true }
      )
    ).toEqual({
      state: initialWindowClosePolicyState,
      decision: { type: 'allow-close' },
      persistCloseToTrayHintSeen: false,
    })
  })

  test('requests application exit when close-to-tray is disabled', () => {
    expect(
      transitionWindowClosePolicy(initialWindowClosePolicyState, {
        type: 'close-requested',
        quitting: false,
        preferences: {
          closeToTrayEnabled: false,
          closeToTrayHintSeen: false,
        },
      })
    ).toEqual({
      state: initialWindowClosePolicyState,
      decision: { type: 'request-quit' },
      persistCloseToTrayHintSeen: false,
    })
  })

  test('requests one confirmation before the first close-to-tray', () => {
    const first = transitionWindowClosePolicy(initialWindowClosePolicyState, {
      type: 'close-requested',
      quitting: false,
      preferences: {
        closeToTrayEnabled: true,
        closeToTrayHintSeen: false,
      },
    })

    expect(first).toEqual({
      state: { status: 'awaiting-close-to-tray-confirmation' },
      decision: { type: 'show-close-to-tray-confirmation' },
      persistCloseToTrayHintSeen: false,
    })
    expect(
      transitionWindowClosePolicy(first.state, {
        type: 'close-requested',
        quitting: false,
        preferences: {
          closeToTrayEnabled: true,
          closeToTrayHintSeen: false,
        },
      })
    ).toEqual({
      state: first.state,
      decision: { type: 'no-action' },
      persistCloseToTrayHintSeen: false,
    })
  })

  test('persists the first confirmation before hiding to the background', () => {
    expect(
      transitionWindowClosePolicy(
        { status: 'awaiting-close-to-tray-confirmation' },
        { type: 'close-to-tray-confirmed' }
      )
    ).toEqual({
      state: initialWindowClosePolicyState,
      decision: { type: 'hide-to-background' },
      persistCloseToTrayHintSeen: true,
    })
  })

  test('returns to idle after cancellation so a later close requests confirmation again', () => {
    expect(
      transitionWindowClosePolicy(
        { status: 'awaiting-close-to-tray-confirmation' },
        { type: 'close-to-tray-cancelled' }
      )
    ).toEqual({
      state: initialWindowClosePolicyState,
      decision: { type: 'no-action' },
      persistCloseToTrayHintSeen: false,
    })
  })

  test('hides directly after the close-to-tray hint has been seen', () => {
    expect(
      transitionWindowClosePolicy(initialWindowClosePolicyState, {
        type: 'close-requested',
        quitting: false,
        preferences: {
          closeToTrayEnabled: true,
          closeToTrayHintSeen: true,
        },
      })
    ).toEqual({
      state: initialWindowClosePolicyState,
      decision: { type: 'hide-to-background' },
      persistCloseToTrayHintSeen: false,
    })
  })

  test('rejects confirmation events when no confirmation is pending', () => {
    expect(() =>
      transitionWindowClosePolicy(initialWindowClosePolicyState, {
        type: 'close-to-tray-confirmed',
      })
    ).toThrow('without a pending close-to-tray confirmation')
  })
})

describe('WindowClosePolicy', () => {
  test('does not read preferences when quitting already allows the close', async () => {
    const preferences = createPreferenceAccess()
    const policy = new WindowClosePolicy(preferences)

    await expect(policy.requestClose(true)).resolves.toEqual({ type: 'allow-close' })
    expect(preferences.read).not.toHaveBeenCalled()
  })

  test('marks the hint as seen before returning the hide decision', async () => {
    const preferences = createPreferenceAccess()
    const policy = new WindowClosePolicy(preferences)

    await expect(policy.requestClose(false)).resolves.toEqual({
      type: 'show-close-to-tray-confirmation',
    })
    await expect(policy.confirmCloseToTray()).resolves.toEqual({
      type: 'hide-to-background',
    })
    expect(preferences.markCloseToTrayHintSeen).toHaveBeenCalledOnce()
    expect(policy.currentState()).toEqual(initialWindowClosePolicyState)
  })

  test('keeps confirmation pending when persistence fails', async () => {
    const preferences = createPreferenceAccess()
    preferences.markCloseToTrayHintSeen.mockRejectedValueOnce(new Error('write failed'))
    const policy = new WindowClosePolicy(preferences)

    await policy.requestClose(false)

    await expect(policy.confirmCloseToTray()).rejects.toThrow('write failed')
    expect(policy.currentState()).toEqual({
      status: 'awaiting-close-to-tray-confirmation',
    })
  })
})

function createPreferenceAccess(): {
  read: ReturnType<typeof vi.fn<WindowClosePreferenceAccess['read']>>
  markCloseToTrayHintSeen: ReturnType<
    typeof vi.fn<WindowClosePreferenceAccess['markCloseToTrayHintSeen']>
  >
} {
  return {
    read: vi.fn(async () => ({
      closeToTrayEnabled: true,
      closeToTrayHintSeen: false,
    })),
    markCloseToTrayHintSeen: vi.fn(async () => undefined),
  }
}
