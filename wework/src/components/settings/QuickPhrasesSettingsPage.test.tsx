import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import {
  defaultAppPreferences,
  emitAppPreferencesChanged,
  type AppPreferencesPatch,
} from '@/desktop/appPreferences'
import { AppPreferencesProvider } from '@/features/app-preferences/AppPreferencesProvider'
import { QuickPhrasesSettingsPage } from './QuickPhrasesSettingsPage'

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }))
vi.mock('@/desktop/appPreferences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/appPreferences')>()),
  getReadableAppPreferences: api.get,
  updateAppPreferences: api.update,
}))
vi.mock('@/telemetry/client', () => ({ track: vi.fn() }))

test('shares preferences with the application and reflects saves and external edits', async () => {
  const phrase = { id: 'custom', title: 'Saved phrase', content: 'Hello', mode: 'normal' as const }
  api.get.mockResolvedValue({ ...defaultAppPreferences, quickPhrases: [phrase] })
  api.update.mockImplementation(async (patch: AppPreferencesPatch) => {
    const preferences = { ...defaultAppPreferences, ...patch }
    emitAppPreferencesChanged(preferences)
    return preferences
  })
  render(
    <AppPreferencesProvider>
      <QuickPhrasesSettingsPage />
    </AppPreferencesProvider>
  )
  await screen.findByText('Saved phrase')
  expect(api.get).toHaveBeenCalledTimes(1)
  await act(async () =>
    emitAppPreferencesChanged({
      ...defaultAppPreferences,
      quickPhrases: [{ ...phrase, title: 'External edit' }],
    })
  )
  expect(screen.getByText('External edit')).toBeInTheDocument()
  await userEvent.click(screen.getByTestId('quick-phrase-edit-custom'))
  const title = screen.getByTestId('quick-phrase-title-input')
  await userEvent.clear(title)
  await userEvent.type(title, 'Updated phrase')
  await userEvent.click(screen.getByTestId('quick-phrase-save-button'))
  await screen.findByText('Updated phrase')
  expect(api.update).toHaveBeenCalledWith({
    quickPhrases: [{ ...phrase, title: 'Updated phrase' }],
  })
  expect(api.get).toHaveBeenCalledTimes(1)
})
