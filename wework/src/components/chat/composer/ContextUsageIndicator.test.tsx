import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { defaultAppPreferences } from '@/tauri/appPreferences'
import type { AppPreferences } from '@/tauri/appPreferences'
import type { RuntimeContextUsage } from '@/types/api'
import { ContextUsageIndicator } from './ContextUsageIndicator'

function makeUsage(usedPercent: number): RuntimeContextUsage {
  const modelContextWindow = 1000
  const usedTokens = (modelContextWindow * usedPercent) / 100
  const breakdown = {
    totalTokens: usedTokens,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  }
  return {
    modelContextWindow,
    total: breakdown,
    last: breakdown,
  }
}

function renderIndicator(
  usage: RuntimeContextUsage,
  preferences: Partial<AppPreferences> = {},
  props: { disabled?: boolean; onCompactContext?: () => void } = {}
) {
  return render(
    <AppPreferencesContext.Provider
      value={{ preferences: { ...defaultAppPreferences, ...preferences }, loaded: true }}
    >
      <ContextUsageIndicator usage={usage} {...props} />
    </AppPreferencesContext.Provider>
  )
}

function hint(): HTMLElement | null {
  return screen.queryByTestId('context-usage-compact-hint')
}

describe('ContextUsageIndicator', () => {
  it('uses theme-aware semantic colors for the usage ring', () => {
    renderIndicator(makeUsage(50))

    const button = screen.getByTestId('context-usage-button')
    const visual = button.querySelector('.context-usage-compact-visual')

    expect(button).toHaveClass('text-text-muted')
    expect(visual).toHaveClass('text-text-muted')
    expect(visual).toHaveStyle({
      background: 'conic-gradient(currentColor 180deg, rgb(var(--color-border) / 0.7) 0deg)',
    })
  })

  it('shows no compact hint below the default threshold', () => {
    renderIndicator(makeUsage(84))
    expect(hint()).not.toBeInTheDocument()
  })

  it('shows the compact hint at or above the default threshold', () => {
    const { rerender } = renderIndicator(makeUsage(85), {}, { onCompactContext: vi.fn() })
    expect(hint()).toBeInTheDocument()
    rerender(
      <AppPreferencesContext.Provider value={{ preferences: defaultAppPreferences, loaded: true }}>
        <ContextUsageIndicator usage={makeUsage(86)} onCompactContext={vi.fn()} />
      </AppPreferencesContext.Provider>
    )
    expect(hint()).toBeInTheDocument()
  })

  it('respects a custom threshold from preferences', () => {
    const { rerender } = renderIndicator(
      makeUsage(82),
      { contextCompactionThreshold: 80 },
      { onCompactContext: vi.fn() }
    )
    expect(hint()).toBeInTheDocument()

    rerender(
      <AppPreferencesContext.Provider
        value={{
          preferences: { ...defaultAppPreferences, contextCompactionThreshold: 90 },
          loaded: true,
        }}
      >
        <ContextUsageIndicator usage={makeUsage(82)} onCompactContext={vi.fn()} />
      </AppPreferencesContext.Provider>
    )
    expect(hint()).not.toBeInTheDocument()

    rerender(
      <AppPreferencesContext.Provider
        value={{
          preferences: { ...defaultAppPreferences, contextCompactionThreshold: 90 },
          loaded: true,
        }}
      >
        <ContextUsageIndicator usage={makeUsage(91)} onCompactContext={vi.fn()} />
      </AppPreferencesContext.Provider>
    )
    expect(hint()).toBeInTheDocument()
  })

  it('hides the hint over the threshold when compacting is unavailable', () => {
    const { rerender } = renderIndicator(makeUsage(90), {}, { disabled: true })
    expect(hint()).not.toBeInTheDocument()
    rerender(
      <AppPreferencesContext.Provider value={{ preferences: defaultAppPreferences, loaded: true }}>
        <ContextUsageIndicator usage={makeUsage(90)} />
      </AppPreferencesContext.Provider>
    )
    expect(hint()).not.toBeInTheDocument()
  })

  it('opens the confirm popover from the hint and compacts on confirm', async () => {
    const user = userEvent.setup()
    const onCompactContext = vi.fn()
    renderIndicator(makeUsage(90), {}, { onCompactContext })

    await user.click(screen.getByTestId('context-usage-compact-hint'))
    expect(screen.getByTestId('compact-context-confirm-popover')).toBeInTheDocument()
    expect(onCompactContext).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('confirm-compact-context-button'))
    expect(onCompactContext).toHaveBeenCalledTimes(1)
  })
})
