import { createContext } from 'react'
import type { LoginRequest } from '@/api/auth'
import type { User } from '@/types/api'
import type { CloudConnectionSnapshot } from './cloudConnectionStorage'

export interface CloudConnectionContextValue extends CloudConnectionSnapshot {
  isConnected: boolean
  serviceKey: string
  connectWithPassword: (backendUrl: string, credentials: LoginRequest) => Promise<User>
  setupAdminPassword: (backendUrl: string, password: string) => Promise<User>
  refreshUser: () => Promise<User | null>
  disconnect: () => void
}

export const DISCONNECTED_STATE: CloudConnectionSnapshot = {
  status: 'disconnected',
  token: null,
  tokenExpiresAt: null,
  user: null,
  connectedAt: null,
  error: null,
}

export const CloudConnectionContext = createContext<CloudConnectionContextValue | null>(null)
