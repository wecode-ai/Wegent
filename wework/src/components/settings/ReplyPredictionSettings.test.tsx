import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAppPreferences, type AppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { ReplyPredictionSettings } from './ReplyPredictionSettings'

const save = vi.hoisted(() => vi.fn())
vi.mock('@/desktop/appPreferences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/appPreferences')>()),
  updateAppPreferences: save,
}))

const configured = {
  modelName: 'model-a',
  modelType: 'runtime',
  executionModelId: 'model-a',
  executionModelType: 'runtime',
}
function setup(
  preferences: Partial<AppPreferences> = {},
  available = true,
  requestCatalogs = vi.fn()
) {
  render(
    <AppPreferencesContext.Provider
      value={{ loaded: true, preferences: { ...defaultAppPreferences, ...preferences } }}
    >
      <WorkbenchContext.Provider
        value={
          {
            projectChat: {
              requestCatalogs,
              models: available
                ? [
                    {
                      name: 'model-a',
                      type: 'runtime',
                      displayName: 'Independent predictor',
                      isActive: true,
                    },
                  ]
                : [],
            },
          } as unknown as WorkbenchContextValue
        }
      >
        <ReplyPredictionSettings />
      </WorkbenchContext.Provider>
    </AppPreferencesContext.Provider>
  )
}

describe('reply prediction settings', () => {
  beforeEach(() => {
    save.mockReset()
    save.mockResolvedValue(defaultAppPreferences)
  })
  it('requests the shared model catalog when opening settings before any conversation', () => {
    const requestCatalogs = vi.fn()
    setup({}, false, requestCatalogs)
    expect(requestCatalogs).toHaveBeenCalledTimes(1)
  })
  it('lets the user enable suggestions before choosing an independent model', async () => {
    setup()
    expect(screen.queryByTestId('reply-prediction-model')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('reply-prediction-enabled'))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ replyPredictionsEnabled: true }))
  })
  it('requires explicit model selection after enabling suggestions', async () => {
    setup({ replyPredictionsEnabled: true })
    fireEvent.change(screen.getByTestId('reply-prediction-model'), {
      target: { value: 'runtime:model-a' },
    })
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          replyPredictionModel: expect.objectContaining({ modelName: 'model-a' }),
        })
      )
    )
  })
  it('switches back to the task model without changing the enabled preference', async () => {
    setup({ replyPredictionModel: configured, replyPredictionsEnabled: true })
    fireEvent.change(screen.getByTestId('reply-prediction-model'), { target: { value: '' } })
    await waitFor(() => expect(save).toHaveBeenCalledWith({ replyPredictionModel: null }))
  })
  it('hides the model selector without clearing the saved model when disabled', () => {
    setup({ replyPredictionModel: configured, replyPredictionsEnabled: false })
    expect(screen.queryByTestId('reply-prediction-model')).not.toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
  })
  it('keeps an unavailable selection and lets the user turn it off', async () => {
    setup({ replyPredictionModel: configured, replyPredictionsEnabled: true }, false)
    expect(screen.getByTestId('reply-prediction-model')).toHaveValue('runtime:model-a')
    fireEvent.click(screen.getByTestId('reply-prediction-enabled'))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ replyPredictionsEnabled: false }))
  })
  it('reports a save failure without silently choosing a different model', async () => {
    save.mockRejectedValue(new Error('storage unavailable'))
    setup({ replyPredictionsEnabled: true })
    fireEvent.change(screen.getByTestId('reply-prediction-model'), {
      target: { value: 'runtime:model-a' },
    })
    expect(await screen.findByRole('alert')).toBeVisible()
    expect(screen.getByTestId('reply-prediction-model')).toHaveValue('')
  })
})
