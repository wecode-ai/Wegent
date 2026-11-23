import { useMemo, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { createSettingsModelApi, type CloudSettingsConnection } from './settings-cloud-api'

/** Each active settings section owns the models belonging to its cloud connection. */
export function useSettingsCloudModels(connection: CloudSettingsConnection) {
  const { isConnected, apiBaseUrl, token } = connection
  const resource = useMemo(
    () =>
      createAsyncResource(
        'settings/cloud-models',
        async signal => {
          signal.throwIfAborted()
          return (
            await createSettingsModelApi({ isConnected: true, apiBaseUrl, token }).listModels()
          ).data
        },
        { refreshOnSubscribe: true }
      ),
    [apiBaseUrl, token]
  )
  const snapshot = useSyncExternalStore(
    isConnected ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  return { snapshot, reload: resource.reload }
}
