import { useMemo } from 'react'
import type { User } from '@/types/api'
import type { WorkbenchState } from '@/types/workbench'
import type { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import {
  createDefaultWorkbenchServices,
  createExecutorClientForWorkbenchServices,
  type WorkbenchServices,
} from './workbenchServices'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { getRuntimeConfig } from '@/config/runtime'
import {
  createLocalDevicePluginApi,
  resolveLocalPluginDeviceRouteId,
} from '@/features/plugins/pluginDeviceApi'
import { createPluginApi } from '@/api/plugins'
import { createHttpClient } from '@/api/http'
export function useWorkbenchServiceGraph(
  workbenchIdentity: User,
  cloudConnection: ReturnType<typeof useOptionalCloudConnection>,
  services?: WorkbenchServices
) {
  const runtimeServiceUser = useMemo<User>(
    () => ({
      id: workbenchIdentity.id,
      user_name: workbenchIdentity.user_name,
      email: workbenchIdentity.email,
    }),
    [workbenchIdentity.email, workbenchIdentity.id, workbenchIdentity.user_name]
  )
  const resolvedServices = useMemo(
    () =>
      services ??
      createDefaultWorkbenchServices({
        isConnected: cloudConnection.isConnected,
        backendUrl: cloudConnection.backendUrl,
        apiBaseUrl: cloudConnection.apiBaseUrl,
        socketBaseUrl: cloudConnection.socketBaseUrl,
        socketPath: cloudConnection.socketPath,
        token: cloudConnection.token,
        user: runtimeServiceUser,
      }),
    [
      cloudConnection.apiBaseUrl,
      cloudConnection.backendUrl,
      cloudConnection.isConnected,
      cloudConnection.socketBaseUrl,
      cloudConnection.socketPath,
      cloudConnection.token,
      runtimeServiceUser,
      services,
    ]
  )
  const executorClient = useMemo(() => {
    return createExecutorClientForWorkbenchServices(resolvedServices)
  }, [resolvedServices])
  return { resolvedServices, executorClient }
}
export function useWorkbenchPluginApis(
  cloudConnection: ReturnType<typeof useOptionalCloudConnection>
) {
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const cloudPluginApi = useMemo(() => {
    const runtime = getRuntimeConfig()
    const profile = {
      apiBaseUrl: cloudConnection.apiBaseUrl || runtime.apiBaseUrl,
      token: cloudConnection.token,
    }
    return createLocalDevicePluginApi(
      createPluginApi(
        createHttpClient({
          baseUrl: profile.apiBaseUrl,
          getToken: () => profile.token,
          redirectOnUnauthorized: false,
        }),
        profile.apiBaseUrl
      ),
      deviceId => resolveLocalPluginDeviceRouteId(deviceId, profile)
    )
  }, [cloudConnection.apiBaseUrl, cloudConnection.token])
  return { localPluginApi, cloudPluginApi }
}
export function useWorkbenchPaneState(state: WorkbenchState) {
  const paneState = useMemo(
    () => ({
      isBootstrapping: state.isBootstrapping,
      projects: state.projects,
      devices: state.devices,
      runtimeWork: state.runtimeWork,
      runtimeWorkLoad: state.runtimeWorkLoad,
      standaloneDeviceId: state.standaloneDeviceId,
      standaloneWorkspacePath: state.standaloneWorkspacePath,
      selectedDeviceWorkspaceId: state.selectedDeviceWorkspaceId,
      pendingProjectWorkspaceProjectId: state.pendingProjectWorkspaceProjectId,
      user: state.user,
      error: state.error,
    }),
    [
      state.devices,
      state.error,
      state.isBootstrapping,
      state.pendingProjectWorkspaceProjectId,
      state.projects,
      state.runtimeWork,
      state.runtimeWorkLoad,
      state.selectedDeviceWorkspaceId,
      state.standaloneDeviceId,
      state.standaloneWorkspacePath,
      state.user,
    ]
  )
  return paneState
}
