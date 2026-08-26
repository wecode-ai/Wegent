import { createContext } from 'react'
import type { AppPreferences } from '@/desktop/appPreferences'

export interface AppPreferencesState {
  preferences: AppPreferences
  loaded: boolean
}

export const AppPreferencesContext = createContext<AppPreferencesState | null>(null)
