import { useCallback, useEffect, useMemo, useState } from 'react'
import { applyAppearance, resolveAppearanceMode } from './applyAppearance'
import { AppearanceContext } from './context'
import { defaultAppearance } from './presets'
import {
  clearStoredAppearance,
  mergeAppearance,
  readStoredAppearance,
  writeStoredAppearance,
} from './storage'
import type { AppearanceConfig, AppearanceUpdate, ResolvedAppearanceMode } from './types'
import { WEWORK_RESET_FONT_SIZE_EVENT, WEWORK_STEP_FONT_SIZE_EVENT } from '@/lib/keybindings'
import { normalizeCodeFontSize, normalizeUiFontSize } from './typography'

function getInitialState(): {
  appearance: AppearanceConfig
  resolvedMode: ResolvedAppearanceMode
} {
  const appearance = readStoredAppearance()
  return {
    appearance,
    resolvedMode: resolveAppearanceMode(appearance.mode),
  }
}

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState(getInitialState)

  useEffect(() => {
    applyAppearance(state.appearance, state.resolvedMode)
    writeStoredAppearance(state.appearance)
  }, [state])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = () => {
      setState(current => {
        if (current.appearance.mode !== 'system') return current
        return {
          ...current,
          resolvedMode: resolveAppearanceMode(current.appearance.mode),
        }
      })
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    const handleResetFontSize = () => {
      setState(current => {
        const appearance = mergeAppearance({
          ...current.appearance,
          uiFontSize: defaultAppearance.uiFontSize,
          codeFontSize: defaultAppearance.codeFontSize,
        })
        return { ...current, appearance }
      })
    }

    window.addEventListener(WEWORK_RESET_FONT_SIZE_EVENT, handleResetFontSize)
    return () => window.removeEventListener(WEWORK_RESET_FONT_SIZE_EVENT, handleResetFontSize)
  }, [])

  useEffect(() => {
    const handleStepFontSize = (event: Event) => {
      const delta = (event as CustomEvent<{ delta?: number }>).detail?.delta
      if (delta !== -1 && delta !== 1) return

      setState(current => {
        const appearance = mergeAppearance({
          ...current.appearance,
          uiFontSize: normalizeUiFontSize(current.appearance.uiFontSize + delta),
          codeFontSize: normalizeCodeFontSize(current.appearance.codeFontSize + delta),
        })
        return { ...current, appearance }
      })
    }

    window.addEventListener(WEWORK_STEP_FONT_SIZE_EVENT, handleStepFontSize)
    return () => window.removeEventListener(WEWORK_STEP_FONT_SIZE_EVENT, handleStepFontSize)
  }, [])

  const setAppearance = useCallback((update: AppearanceUpdate) => {
    setState(current => {
      const appearance = mergeAppearance({
        ...current.appearance,
        ...update,
        light: update.light
          ? { ...current.appearance.light, ...update.light }
          : current.appearance.light,
        dark: update.dark
          ? { ...current.appearance.dark, ...update.dark }
          : current.appearance.dark,
        lightBackground: update.lightBackground
          ? { ...current.appearance.lightBackground, ...update.lightBackground }
          : current.appearance.lightBackground,
        darkBackground: update.darkBackground
          ? { ...current.appearance.darkBackground, ...update.darkBackground }
          : current.appearance.darkBackground,
      })

      return {
        appearance,
        resolvedMode: resolveAppearanceMode(appearance.mode),
      }
    })
  }, [])

  const resetAppearance = useCallback(() => {
    clearStoredAppearance()
    setState({
      appearance: defaultAppearance,
      resolvedMode: resolveAppearanceMode(defaultAppearance.mode),
    })
  }, [])

  const value = useMemo(
    () => ({
      appearance: state.appearance,
      resolvedMode: state.resolvedMode,
      setAppearance,
      resetAppearance,
    }),
    [state, setAppearance, resetAppearance]
  )

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
}
