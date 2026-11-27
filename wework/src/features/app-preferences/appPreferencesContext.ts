import { createContext } from 'react'
import type { AppPreferences } from '@/desktop/appPreferences'

export interface AppPreferencesState {
  preferences: AppPreferences
  loaded: boolean
  loadStatus?: 'loading' | 'ready' | 'error'
  retry?: () => void
}

export const AppPreferencesContext = createContext<AppPreferencesState | null>(null)
