import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { QuickPhrasesSettingsPage } from './QuickPhrasesSettingsPage'

const getAppPreferences = vi.hoisted(() => vi.fn())
const updateAppPreferences = vi.hoisted(() => vi.fn())

vi.mock('@/tauri/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/tauri/appPreferences')>()
  return { ...actual, getAppPreferences, updateAppPreferences }
})

describe('QuickPhrasesSettingsPage', () => {
  beforeEach(() => {
    getAppPreferences.mockResolvedValue({ quickPhrases: [] })
    updateAppPreferences.mockImplementation(async patch => ({ quickPhrases: patch.quickPhrases }))
  })

  test('creates a plan-mode phrase', async () => {
    render(<QuickPhrasesSettingsPage />)
    fireEvent.click(screen.getByTestId('add-quick-phrase-button'))
    fireEvent.change(screen.getByTestId('quick-phrase-title-input'), {
      target: { value: '制定计划' },
    })
    fireEvent.change(screen.getByTestId('quick-phrase-content-input'), {
      target: { value: '请制定实施计划' },
    })
    fireEvent.click(screen.getByTestId('quick-phrase-mode-plan'))
    fireEvent.click(screen.getByTestId('quick-phrase-save-button'))

    await waitFor(() =>
      expect(updateAppPreferences).toHaveBeenCalledWith({
        quickPhrases: [
          expect.objectContaining({
            title: '制定计划',
            content: '请制定实施计划',
            mode: 'plan',
          }),
        ],
      })
    )
  })
})
