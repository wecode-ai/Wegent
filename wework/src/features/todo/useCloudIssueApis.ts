import { useMemo } from 'react'
import { createDeliveryApi } from '@/api/deliveries'
import { createHttpClient } from '@/api/http'
import { createPersonalIssuesApi } from '@/api/personalIssues'
import { createProjectAutomationApi } from '@/api/projectAutomations'
import { createProjectIncomingHookApi } from '@/api/projectIncomingHooks'
import { createRuntimeProfileApi } from '@/api/runtimeProfiles'
import { getRuntimeConfig } from '@/config/runtime'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'
import { createWeworkSharedWorkspaceApi } from '@/features/collaboration/weworkSharedWorkspaceApi'

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
    const projects = createDeliveryApi(client)
    return {
      personal: createPersonalIssuesApi(client),
      projects,
      collaboration: createWeworkSharedWorkspaceApi({
        client,
        deliveryApi: projects,
        projectAutomationApi: createProjectAutomationApi(client),
        projectIncomingHookApi: createProjectIncomingHookApi(client),
        runtimeProfileApi: createRuntimeProfileApi(client),
      }),
    }
  }, [apiBaseUrl, baseUrl, fallbackToken, getTokenForAccount, isConnected, userId])
}
