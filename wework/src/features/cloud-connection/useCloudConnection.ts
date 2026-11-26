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
  const { apiBaseUrl = '', socketBaseUrl = '', socketPath = '' } = context ? {} : getRuntimeConfig()
  const fallbackToken = context ? '' : (localStorage.getItem('auth_token') ?? 'fallback-token')
  return useMemo<CloudConnectionContextValue>(() => {
    if (context) return context
    const fallbackUser = { id: 0, user_name: 'backend', email: '' }
    return {
      status: 'connected',
      backendUrl: socketBaseUrl,
      apiBaseUrl,
      socketBaseUrl,
      socketPath,
      credentialMode: 'legacy_access_token',
      token: fallbackToken,
      tokenExpiresAt: null,
      user: fallbackUser,
      connectedAt: null,
      error: null,
      isConnected: true,
      serviceKey: `fallback:${apiBaseUrl}`,
      connectWithAuthorization: async () => {
        throw new Error('Cloud connection provider is unavailable')
      },
      refreshUser: async () => fallbackUser,
      disconnect: () => undefined,
    }
  }, [apiBaseUrl, context, fallbackToken, socketBaseUrl, socketPath])
}
