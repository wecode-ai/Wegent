import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  applyAppearance,
  resolveAppearanceMode,
  resolveAppearanceThemeVariables,
} from './applyAppearance'
import { AppearanceContext } from './context'
import { defaultAppearance } from './presets'
import {
  clearStoredAppearance,
  APPEARANCE_STORAGE_KEY,
  mergeAppearance,
  readStoredAppearance,
  writeStoredAppearance,
} from './storage'
import type { AppearanceConfig, AppearanceUpdate, ResolvedAppearanceMode } from './types'
import { WEWORK_RESET_FONT_SIZE_EVENT, WEWORK_STEP_FONT_SIZE_EVENT } from '@/lib/keybindings'
import { normalizeCodeFontSize, normalizeUiFontSize } from './typography'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  getAppPreferences,
  updateAppPreferences,
  type AppPreferences,
} from '@/desktop/appPreferences'
import { isElectronRuntime } from '@/lib/runtime-environment'

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

export function AppearanceProvider({
  children,
  persist = true,
}: {
  children: React.ReactNode
  /** Auxiliary windows apply appearance but must not own or overwrite it. */
  persist?: boolean
}) {
  const [state, setState] = useState(getInitialState)

  useEffect(() => {
    applyAppearance(state.appearance, state.resolvedMode)
    if (persist) writeStoredAppearance(state.appearance)
  }, [persist, state])

  useEffect(() => {
    if (!persist || !isElectronRuntime()) return
    const appearance = state.appearance
    void updateAppPreferences({
      appearanceMode: appearance.mode,
      appearanceThemeSnapshot: {
        light: {
          themeId: appearance.lightThemeId,
          variables: resolveAppearanceThemeVariables(appearance, 'light'),
        },
        dark: {
          themeId: appearance.darkThemeId,
          variables: resolveAppearanceThemeVariables(appearance, 'dark'),
        },
      },
    }).catch(error => {
      console.error('[Wework] Failed to persist the desktop appearance:', error)
    })
  }, [persist, state.appearance])

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      // Auxiliary-window bootstrap clears and restores origin storage. Its
      // transient clear is not a request to reset the selected appearance.
      if (event.key !== APPEARANCE_STORAGE_KEY) return
      const appearance = readStoredAppearance()
      setState({
        appearance,
        resolvedMode: resolveAppearanceMode(appearance.mode),
      })
    }

    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  useEffect(() => {
    if (persist || !isElectronRuntime()) return
    let active = true
    let receivedChange = false
    const applyMode = (mode: unknown) => {
      if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return
      setState(current => {
        if (current.appearance.mode === mode) return current
        const appearance = mergeAppearance({ ...current.appearance, mode })
        return { appearance, resolvedMode: resolveAppearanceMode(mode) }
      })
    }
    const handlePreferencesChanged = (event: Event) => {
      receivedChange = true
      applyMode((event as CustomEvent<AppPreferences>).detail?.appearanceMode)
    }
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)
    void getAppPreferences()
      .then(preferences => {
        if (active && !receivedChange) applyMode(preferences.appearanceMode)
      })
      .catch(error => {
        console.error('[Wework] Failed to read the auxiliary window appearance mode:', error)
      })
    return () => {
      active = false
      window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)
    }
  }, [persist])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = () => {
      setState(current => {
        if (current.appearance.mode !== 'system') return current
        return {
          appearance: mergeAppearance(current.appearance),
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
      const mode = current.resolvedMode
      const themeOverrides = { ...current.appearance.themeOverrides, ...update.themeOverrides }
      if (update.accentColor !== undefined) {
        themeOverrides[mode] = { ...themeOverrides[mode], accentColor: update.accentColor }
      }
      for (const paletteMode of ['light', 'dark'] as const) {
        if (update[paletteMode]) {
          themeOverrides[paletteMode] = {
            ...themeOverrides[paletteMode],
            palette: { ...themeOverrides[paletteMode].palette, ...update[paletteMode] },
          }
        }
      }
      const appearance = mergeAppearance({
        ...current.appearance,
        ...update,
        themeOverrides,
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
