import { createContext } from 'react'
import type { StandInBindingTarget } from '@/api/standIn'

export const StandInBindingContext = createContext<StandInBindingTarget | null>(null)
