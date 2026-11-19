import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { useQuickPhrases } from './useQuickPhrases'

const invoke = vi.hoisted(() => vi.fn().mockRejectedValue(new Error('Desktop host unavailable')))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: invoke }))

it('uses and updates provider phrases without requiring a desktop host', async () => {
  function Consumer() {
    return (
      <output>
        {useQuickPhrases()
          .map(phrase => phrase.title)
          .join(',')}
      </output>
    )
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  const preferences = {
    ...defaultAppPreferences,
    quickPhrases: [
      { id: 'example', title: 'Provider phrase', content: 'Example', mode: 'normal' as const },
    ],
  }
  try {
    await act(async () =>
      root.render(
        <AppPreferencesContext.Provider value={{ preferences, loaded: true }}>
          <Consumer />
        </AppPreferencesContext.Provider>
      )
    )
    expect(container.textContent).toBe('Provider phrase')
    await act(async () =>
      root.render(
        <AppPreferencesContext.Provider
          value={{ preferences: { ...preferences, quickPhrases: [] }, loaded: true }}
        >
          <Consumer />
        </AppPreferencesContext.Provider>
      )
    )
    expect(container.textContent).toBe('')
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
  }
})
