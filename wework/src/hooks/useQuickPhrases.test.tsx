import { act, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  defaultAppPreferences,
  defaultQuickPhrases,
  type AppPreferences,
} from '@/desktop/appPreferences'
import { AppPreferencesProvider } from '@/features/app-preferences/AppPreferencesProvider'
import { useQuickPhrases } from './useQuickPhrases'

const getAppPreferencesMock = vi.hoisted(() => vi.fn())
vi.mock('@/desktop/appPreferences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/appPreferences')>()),
  getAppPreferences: getAppPreferencesMock,
}))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => false }))

const preferences = (title: string): AppPreferences => ({
  ...defaultAppPreferences,
  quickPhrases: [{ id: title, title, content: title, mode: 'normal' }],
})

function deferredPreferences() {
  let resolve!: (value: AppPreferences) => void
  const promise = new Promise<AppPreferences>(complete => {
    resolve = complete
  })
  getAppPreferencesMock.mockReturnValue(promise)
  return { promise, resolve }
}

function changePreferences(title: string) {
  window.dispatchEvent(
    new CustomEvent(APP_PREFERENCES_CHANGED_EVENT, { detail: preferences(title) })
  )
}

function Probe({ label }: { label: string }) {
  return <div data-testid={label}>{useQuickPhrases()[0]?.title}</div>
}

beforeEach(() => {
  getAppPreferencesMock.mockReset().mockResolvedValue(preferences('loaded'))
})

test('shares one provider read and listener between multiple quick phrase consumers', async () => {
  const pending = deferredPreferences()
  const addListener = vi.spyOn(window, 'addEventListener')
  const removeListener = vi.spyOn(window, 'removeEventListener')
  const view = render(
    <AppPreferencesProvider>
      <Probe label="first" />
      <Probe label="second" />
    </AppPreferencesProvider>
  )
  expect(screen.getByTestId('first')).toHaveTextContent(defaultQuickPhrases[0].title)
  expect(screen.getByTestId('second')).toHaveTextContent(defaultQuickPhrases[0].title)
  expect(getAppPreferencesMock).toHaveBeenCalledTimes(1)
  const preferenceListeners = addListener.mock.calls.filter(
    ([name]) => name === APP_PREFERENCES_CHANGED_EVENT
  )
  expect(preferenceListeners).toHaveLength(1)
  await act(async () => pending.resolve(preferences('loaded')))
  expect(screen.getByTestId('first')).toHaveTextContent('loaded')
  expect(screen.getByTestId('second')).toHaveTextContent('loaded')
  act(() => changePreferences('changed'))
  expect(screen.getByTestId('first')).toHaveTextContent('changed')
  expect(screen.getByTestId('second')).toHaveTextContent('changed')
  view.unmount()
  expect(removeListener).toHaveBeenCalledWith(
    APP_PREFERENCES_CHANGED_EVENT,
    preferenceListeners[0][1]
  )
})

test('provider events take priority over an outstanding initial read', async () => {
  const pending = deferredPreferences()
  const { result } = renderHook(useQuickPhrases, { wrapper: AppPreferencesProvider })
  act(() => changePreferences('newer'))
  await act(async () => pending.resolve(preferences('stale')))
  expect(result.current).toEqual(preferences('newer').quickPhrases)
  expect(getAppPreferencesMock).toHaveBeenCalledTimes(1)
})

test('standalone consumers retain initial loading and preference updates', async () => {
  const pending = deferredPreferences()
  const { result } = renderHook(useQuickPhrases)
  expect(result.current).toBe(defaultQuickPhrases)
  await act(async () => pending.resolve(preferences('loaded')))
  expect(result.current).toEqual(preferences('loaded').quickPhrases)
  act(() => changePreferences('changed'))
  expect(result.current).toEqual(preferences('changed').quickPhrases)
  expect(getAppPreferencesMock).toHaveBeenCalledTimes(1)
})

test('standalone events take priority over an outstanding initial read', async () => {
  const pending = deferredPreferences()
  const { result } = renderHook(useQuickPhrases)
  act(() => changePreferences('newer'))
  await act(async () => pending.resolve(preferences('stale')))
  expect(result.current).toEqual(preferences('newer').quickPhrases)
})

test.each([false, true])(
  'unmount removes the preference listener while loading (provider=%s)',
  async provider => {
    const pending = deferredPreferences()
    const addListener = vi.spyOn(window, 'addEventListener')
    const removeListener = vi.spyOn(window, 'removeEventListener')
    const { result, unmount } = renderHook(useQuickPhrases, {
      wrapper: provider ? AppPreferencesProvider : undefined,
    })
    const listener = addListener.mock.calls.find(
      ([name]) => name === APP_PREFERENCES_CHANGED_EVENT
    )?.[1]
    expect(listener).toBeDefined()
    unmount()
    expect(removeListener).toHaveBeenCalledWith(APP_PREFERENCES_CHANGED_EVENT, listener)
    await act(async () => {
      changePreferences('after-unmount')
      pending.resolve(preferences('late'))
    })
    expect(result.current).toBe(defaultQuickPhrases)
  }
)
