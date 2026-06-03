import { createContext } from 'react'
import type { AppearanceContextValue } from './types'

export const AppearanceContext = createContext<AppearanceContextValue | undefined>(undefined)
