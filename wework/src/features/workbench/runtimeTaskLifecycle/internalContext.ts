import { createContext } from 'react'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

export const RuntimeTaskLifecycleContext = createContext<RuntimeTaskLifecycleStore | null>(null)
