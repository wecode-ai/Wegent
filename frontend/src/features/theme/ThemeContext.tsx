// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import type { ThemeMode } from './themeConfig'

const THEME_STORAGE_KEY = 'wegent-theme-mode'

export type ThemeContextValue = {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  toggleMode: () => void
  isReady: boolean
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>('dark')
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const stored = window.localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode | null
    const prefersDark =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : true
    const resolvedMode = stored === 'light' || stored === 'dark' ? stored : prefersDark ? 'dark' : 'light'

    document.documentElement.dataset.theme = resolvedMode
    setMode(resolvedMode)
    setIsReady(true)
  }, [])

  useEffect(() => {
    if (!isReady || typeof window === 'undefined') {
      return
    }

    document.documentElement.dataset.theme = mode
    window.localStorage.setItem(THEME_STORAGE_KEY, mode)
  }, [mode, isReady])

  const handleSetMode = useCallback((nextMode: ThemeMode) => {
    setMode(nextMode)
  }, [])

  const toggleMode = useCallback(() => {
    setMode((prev) => (prev === 'dark' ? 'light' : 'dark'))
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      setMode: handleSetMode,
      toggleMode,
      isReady,
    }),
    [handleSetMode, isReady, mode, toggleMode]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)

  if (context === null) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }

  return context
}
