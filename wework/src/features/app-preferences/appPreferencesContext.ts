import { createContext } from 'react'
import type { AppPreferences } from '@/tauri/appPreferences'

export interface AppPreferencesState {
  preferences: AppPreferences
  loaded: boolean
}

export const AppPreferencesContext = createContext<AppPreferencesState | null>(null)
