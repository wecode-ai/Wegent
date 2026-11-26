import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { canonicalizeBrowserLocation, useCurrentLocation } from './appLocation'

afterEach(() => window.history.replaceState(null, '', '/'))

test('replaces a legacy assistant location at startup and on history navigation', () => {
  const state = { navigationId: 42 }
  window.history.replaceState(state, '', '/collaboration-exp?view=assistant&profileId=one#anchor')

  expect(canonicalizeBrowserLocation()).toBe('/stand-in?profileId=one')
  expect(window.location.pathname + window.location.search + window.location.hash).toBe(
    '/stand-in?profileId=one#anchor'
  )
  expect(window.history.state).toEqual(state)

  const { result } = renderHook(useCurrentLocation)
  const onLocation = vi.fn(() => window.location.pathname)
  window.addEventListener('popstate', onLocation)
  try {
    act(() => {
      window.history.replaceState(
        state,
        '',
        '/collaboration-exp?view=assistant&profileId=two&settingsRequest=profile&foo=bar'
      )
      window.dispatchEvent(new PopStateEvent('popstate', { state }))
    })

    expect(result.current).toEqual({
      pathname: '/stand-in',
      search: '?profileId=two&settingsRequest=profile&foo=bar',
    })
    expect(onLocation).toHaveBeenCalledTimes(1)
    expect(onLocation).toHaveReturnedWith('/stand-in')
    expect(window.history.state).toEqual(state)
  } finally {
    window.removeEventListener('popstate', onLocation)
  }
})
