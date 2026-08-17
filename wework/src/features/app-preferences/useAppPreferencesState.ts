import { useContext } from 'react'
import { AppPreferencesContext } from './appPreferencesContext'

export function useAppPreferencesState() {
  return useContext(AppPreferencesContext)
}
