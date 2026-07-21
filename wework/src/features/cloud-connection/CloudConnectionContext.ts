import { createContext } from 'react'
import type { User } from '@/types/api'
import type { CloudConnectionSnapshot } from './cloudConnectionStorage'

export interface CloudAuthorizationHandle {
  closed?: Promise<void>
  close?: () => Promise<void> | void
}

export type OpenCloudAuthorizationUrl = (
  url: string
) => Promise<CloudAuthorizationHandle | void> | CloudAuthorizationHandle | void

export interface CloudConnectionContextValue extends CloudConnectionSnapshot {
  isConnected: boolean
  serviceKey: string
  connectWithAuthorization: (
    backendUrl: string,
    openAuthorizationUrl?: OpenCloudAuthorizationUrl,
    socketBaseUrlOverride?: string
  ) => Promise<User>
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
