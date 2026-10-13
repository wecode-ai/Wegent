import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAppPreferences, type AppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { ReplyPredictionSettings } from './ReplyPredictionSettings'

const save = vi.hoisted(() => vi.fn())
vi.mock('@/desktop/appPreferences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/appPreferences')>()),
  updateAppPreferences: save,
}))
function setup(preferences: Partial<AppPreferences> = {}) {
  render(
    <AppPreferencesContext.Provider
      value={{ loaded: true, preferences: { ...defaultAppPreferences, ...preferences } }}
    >
      <ReplyPredictionSettings />
    </AppPreferencesContext.Provider>
  )
}
describe('reply prediction settings', () => {
  beforeEach(() => {
    save.mockReset()
    save.mockResolvedValue(defaultAppPreferences)
  })
  it('enables predictions without a model catalog or model selector', async () => {
    setup()
    fireEvent.click(screen.getByTestId('reply-prediction-enabled'))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ replyPredictionsEnabled: true }))
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
  it('keeps only the toggle when enabled and can disable predictions', async () => {
    setup({ replyPredictionsEnabled: true })
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('reply-prediction-enabled'))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ replyPredictionsEnabled: false }))
  })
  it('reports a preference save failure', async () => {
    save.mockRejectedValue(new Error('storage unavailable'))
    setup()
    fireEvent.click(screen.getByTestId('reply-prediction-enabled'))
    expect(await screen.findByRole('alert')).toBeVisible()
  })
})
