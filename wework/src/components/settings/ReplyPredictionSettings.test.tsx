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
function setup(preferences: Partial<AppPreferences> = {}, available = true) {
  render(
    <AppPreferencesContext.Provider
      value={{ loaded: true, preferences: { ...defaultAppPreferences, ...preferences } }}
    >
      <WorkbenchContext.Provider
        value={
          {
            projectChat: {
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
  it('requires explicit model selection and enables the first selection', async () => {
    setup()
    expect(screen.getByTestId('reply-prediction-enabled')).toBeDisabled()
    fireEvent.change(screen.getByTestId('reply-prediction-model'), {
      target: { value: 'runtime:model-a' },
    })
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          replyPredictionsEnabled: true,
          replyPredictionModel: expect.objectContaining({ modelName: 'model-a' }),
        })
      )
    )
  })
  it('preserves the disabled preference when changing an existing model', async () => {
    setup({ replyPredictionModel: configured, replyPredictionsEnabled: false })
    fireEvent.change(screen.getByTestId('reply-prediction-model'), {
      target: { value: 'runtime:model-a' },
    })
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ replyPredictionsEnabled: false }))
    )
  })
  it('keeps an unavailable selection and lets the user turn it off', async () => {
    setup({ replyPredictionModel: configured, replyPredictionsEnabled: true }, false)
    expect(screen.getByTestId('reply-prediction-model')).toHaveValue('runtime:model-a')
    fireEvent.click(screen.getByTestId('reply-prediction-enabled'))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ replyPredictionsEnabled: false }))
  })
  it('reports a save failure without silently choosing a different model', async () => {
    save.mockRejectedValue(new Error('storage unavailable'))
    setup()
    fireEvent.change(screen.getByTestId('reply-prediction-model'), {
      target: { value: 'runtime:model-a' },
    })
    expect(await screen.findByRole('alert')).toBeVisible()
    expect(screen.getByTestId('reply-prediction-model')).toHaveValue('')
  })
})
