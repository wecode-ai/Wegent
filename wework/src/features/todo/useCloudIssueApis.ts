import { useMemo } from 'react'
import { createDeliveryApi } from '@/api/deliveries'
import { createHttpClient } from '@/api/http'
import { createPersonalIssuesApi } from '@/api/personalIssues'
import { getRuntimeConfig } from '@/config/runtime'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'

export function useCloudIssueApis({ apiBaseUrl, isConnected, token }: CloudConnectionContextValue) {
  const baseUrl = apiBaseUrl ?? getRuntimeConfig().apiBaseUrl
  return useMemo(() => {
    if (!isConnected) return null
    const client = createHttpClient({
      baseUrl,
      getToken: () => token,
      redirectOnUnauthorized: false,
    })
    return { personal: createPersonalIssuesApi(client), projects: createDeliveryApi(client) }
  }, [baseUrl, isConnected, token])
}
