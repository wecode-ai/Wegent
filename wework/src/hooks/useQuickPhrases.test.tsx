import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  defaultAppPreferences,
  getAppPreferences,
  type QuickPhrase,
} from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { useQuickPhrases } from './useQuickPhrases'

vi.mock('@/desktop/appPreferences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/appPreferences')>()),
  getAppPreferences: vi.fn(),
}))

afterEach(() => vi.restoreAllMocks())

const saved: QuickPhrase[] = [
  { id: 'saved', title: 'Saved', content: 'Saved phrase', mode: 'normal' },
]

test('reuses shared preferences and reacts to their updates without separate Host reads', () => {
  let phrases = saved
  const { result, rerender } = renderHook(useQuickPhrases, {
    wrapper: ({ children }) => (
      <AppPreferencesContext.Provider
        value={{ preferences: { ...defaultAppPreferences, quickPhrases: phrases }, loaded: true }}
      >
        {children}
      </AppPreferencesContext.Provider>
    ),
  })
  expect(result.current).toEqual(saved)
  phrases = []
  rerender()
  expect(result.current).toEqual([])
  expect(getAppPreferences).not.toHaveBeenCalled()
})

test('a failed standalone read preserves a newer preferences event and records the failure', async () => {
  let reject!: (error: Error) => void
  vi.mocked(getAppPreferences).mockReturnValueOnce(
    new Promise((_resolve, fail) => {
      reject = fail
    })
  )
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const failure = new Error('Host is restarting')
  const { result } = renderHook(useQuickPhrases)
  act(() =>
    window.dispatchEvent(
      new CustomEvent(APP_PREFERENCES_CHANGED_EVENT, {
        detail: { ...defaultAppPreferences, quickPhrases: saved },
      })
    )
  )
  reject(failure)
  await waitFor(() =>
    expect(log).toHaveBeenCalledWith('[Wework] Failed to load quick phrases:', failure)
  )
  expect(result.current).toEqual(saved)
})
