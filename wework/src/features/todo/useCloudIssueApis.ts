import { useMemo } from 'react'
import { createDeliveryApi } from '@/api/deliveries'
import { createHttpClient } from '@/api/http'
import { createPersonalIssuesApi } from '@/api/personalIssues'
import { getRuntimeConfig } from '@/config/runtime'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'

export function useCloudIssueApis(connection: CloudConnectionContextValue) {
  const { apiBaseUrl, getTokenForAccount, isConnected, token, user } = connection
  const userId = user?.id
  const fallbackToken = getTokenForAccount ? null : token
  const baseUrl = apiBaseUrl ?? getRuntimeConfig().apiBaseUrl
  return useMemo(() => {
    if (!isConnected) return null
    const client = createHttpClient({
      baseUrl,
      getToken: () => (getTokenForAccount ? getTokenForAccount(apiBaseUrl, userId) : fallbackToken),
      redirectOnUnauthorized: false,
    })
    return { personal: createPersonalIssuesApi(client), projects: createDeliveryApi(client) }
  }, [apiBaseUrl, baseUrl, fallbackToken, getTokenForAccount, isConnected, userId])
}
