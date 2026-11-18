import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { RuntimeStream, CloudConnectionSnapshot } from '@/services/runtimeStream'
import type { DeviceInfo, UnifiedModel } from '@/types/runtime'
import type { RuntimeFailureAction } from './useRuntimeFailures'
import { beginMobileDiagnostic } from '@/services/mobileDiagnostics'

export function useRuntimeCloudConnection({
  api,
  stream,
  identity,
  connection,
  cacheReady,
  applyDevices,
  applyModels,
  onInitialDevices,
  reportFailure,
  clearFailure,
}: {
  api: Pick<RuntimeApi, 'listDevices' | 'listModels'>
  stream: RuntimeStream
  identity: string | null
  connection: CloudConnectionSnapshot
  cacheReady: boolean
  applyDevices: (devices: DeviceInfo[]) => string | null
  applyModels: (models: UnifiedModel[]) => void
  onInitialDevices: (deviceId: string | null) => void
  reportFailure: (failure: Omit<RuntimeFailureAction, 'retrying'>) => void
  clearFailure: (id: string) => void
}) {
  const scope = useMemo(() => ({ identity, initialized: false, devices: 0, models: 0 }), [identity])
  const currentScope = useRef(scope)
  currentScope.current = scope

  const refreshDevices = useCallback(
    async function discover(): Promise<string | null> {
      if (!identity || currentScope.current !== scope || !stream.getCloudConnection().connected)
        return null
      const revision = ++scope.devices
      const diagnostic = beginMobileDiagnostic('cloud-devices', 'cloud')
      try {
        const response = await api.listDevices()
        if (currentScope.current !== scope || revision !== scope.devices) {
          diagnostic.cancel()
          return null
        }
        if (response.error) throw new Error(response.error)
        const selected = applyDevices(response.items)
        clearFailure('cloud-devices')
        diagnostic.complete({ devices: response.items.length })
        return selected
      } catch (cause) {
        diagnostic.fail(cause)
        if (currentScope.current === scope && revision === scope.devices)
          reportFailure({
            id: 'cloud-devices',
            label: '云端设备列表',
            phoneOwned: false,
            error: cause instanceof Error ? cause.message : String(cause),
            retry: discover,
          })
        throw cause
      }
    },
    [api, applyDevices, clearFailure, identity, reportFailure, scope, stream]
  )

  const loadCloudModels = useCallback(
    async function load(): Promise<void> {
      if (!identity || currentScope.current !== scope || !stream.getCloudConnection().connected)
        return
      const revision = ++scope.models
      const diagnostic = beginMobileDiagnostic('cloud-models', 'cloud')
      try {
        const response = await api.listModels()
        if (currentScope.current !== scope || revision !== scope.models) {
          diagnostic.cancel()
          return
        }
        applyModels(response.data)
        clearFailure('cloud-models')
        diagnostic.complete({ models: response.data.length })
      } catch (cause) {
        diagnostic.fail(cause)
        if (currentScope.current === scope && revision === scope.models)
          reportFailure({
            id: 'cloud-models',
            label: '云端模型列表',
            phoneOwned: false,
            error: cause instanceof Error ? cause.message : String(cause),
            retry: load,
          })
        throw cause
      }
    },
    [api, applyModels, clearFailure, identity, reportFailure, scope, stream]
  )

  useEffect(() => {
    if (!identity || connection.connected) {
      clearFailure('cloud-connection')
      return
    }
    reportFailure({
      id: 'cloud-connection',
      label: '云端连接',
      phoneOwned: false,
      error: connection.error?.message ?? '云端尚未连接',
      retry: () => stream.reconnectCloud(),
    })
  }, [identity, connection, stream, clearFailure, reportFailure])

  useEffect(() => {
    if (
      !identity ||
      !cacheReady ||
      !connection.connected ||
      !stream.getCloudConnection().connected ||
      scope.initialized
    )
      return
    scope.initialized = true
    // Discovery and model loading have independent outcomes. Only initial
    // discovery establishes the prerequisites for the selected cloud list.
    void refreshDevices()
      .then(deviceId => {
        if (
          currentScope.current === scope &&
          scope.devices === 1 &&
          stream.getCloudConnection().connected
        )
          onInitialDevices(deviceId)
      })
      .catch(() => {})
    void loadCloudModels().catch(() => {})
  }, [
    identity,
    cacheReady,
    connection.connected,
    refreshDevices,
    loadCloudModels,
    onInitialDevices,
    scope,
    stream,
  ])

  return { refreshDevices, loadCloudModels }
}
