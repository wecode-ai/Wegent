import { useContext, useMemo } from 'react'
import { getRuntimeConfig } from '@/config/runtime'
import { CloudConnectionContext, type CloudConnectionContextValue } from './CloudConnectionContext'

export function useCloudConnection(): CloudConnectionContextValue {
  const context = useContext(CloudConnectionContext)
  if (!context) {
    throw new Error('useCloudConnection must be used within CloudConnectionProvider')
  }
  return context
}

export function useOptionalCloudConnection(): CloudConnectionContextValue {
  const context = useContext(CloudConnectionContext)
  const runtimeConfig = getRuntimeConfig()
  const fallbackToken = localStorage.getItem('auth_token') ?? 'fallback-token'
  const fallback = useMemo<CloudConnectionContextValue>(() => {
    const fallbackUser = { id: 0, user_name: 'backend', email: '' }
    return {
      status: 'connected',
      backendUrl: runtimeConfig.socketBaseUrl,
      apiBaseUrl: runtimeConfig.apiBaseUrl,
      socketBaseUrl: runtimeConfig.socketBaseUrl,
      socketPath: runtimeConfig.socketPath,
      token: fallbackToken,
      tokenExpiresAt: null,
      user: fallbackUser,
      connectedAt: null,
      error: null,
      isConnected: true,
      serviceKey: `fallback:${runtimeConfig.apiBaseUrl}`,
      connectWithAuthorization: async () => {
        throw new Error('Cloud connection provider is unavailable')
      },
      refreshUser: async () => fallbackUser,
      disconnect: () => undefined,
    }
  }, [
    fallbackToken,
    runtimeConfig.apiBaseUrl,
    runtimeConfig.socketBaseUrl,
    runtimeConfig.socketPath,
  ])

  if (context) return context
  return fallback
}
