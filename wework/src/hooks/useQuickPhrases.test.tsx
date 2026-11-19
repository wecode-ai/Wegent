import { renderHook } from '@testing-library/react'
import { expect, test } from 'vitest'
import { defaultAppPreferences, defaultQuickPhrases } from '@/desktop/appPreferences'
import {
  AppPreferencesContext,
  type AppPreferencesState,
} from '@/features/app-preferences/appPreferencesContext'
import { useQuickPhrases } from './useQuickPhrases'
import type { ReactNode } from 'react'

test('uses the shared preference snapshot and updates when the provider changes', () => {
  let state: AppPreferencesState = { preferences: defaultAppPreferences, loaded: false }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppPreferencesContext.Provider value={state}>{children}</AppPreferencesContext.Provider>
  )
  const { result, rerender } = renderHook(useQuickPhrases, { wrapper })
  expect(result.current).toBe(defaultQuickPhrases)
  const quickPhrases = [
    { id: 'custom', title: 'Custom', content: 'Hello', mode: 'normal' as const },
  ]
  state = { preferences: { ...defaultAppPreferences, quickPhrases }, loaded: true }
  rerender()
  expect(result.current).toBe(quickPhrases)
})

test('keeps default phrases outside the application provider', () => {
  expect(renderHook(useQuickPhrases).result.current).toBe(defaultQuickPhrases)
})
