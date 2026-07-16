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
import type {
  AppearanceConfig,
  AppearanceUpdate,
  ResolvedAppearanceMode,
} from './types'

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
    [state, setAppearance, resetAppearance],
  )

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
}
