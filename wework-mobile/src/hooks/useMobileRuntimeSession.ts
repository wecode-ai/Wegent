import { useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react'
import type { RuntimeSessionConfig } from '@/services/backendConfig'
import type { LocalRuntime } from '@/services/localRuntime'
import { LocalRuntimeApi } from '@/services/localRuntimeApi'
import { PHONE_LOCAL_USER } from '@/services/phoneLocalProfile'
import type { PhoneLocalModelStore } from '@/services/phoneLocalModels'
import { RuntimeApi } from '@/services/runtimeApi'
import { MobileRuntimeCache } from '@/services/runtimeCache'
import { RuntimeSessionCache } from '@/services/runtimeSessionCache'
import { RuntimeStream } from '@/services/runtimeStream'
import type { DeviceInfo } from '@/types/runtime'

export interface MobileLocalRuntimeOptions {
  runtime: LocalRuntime
  models?: PhoneLocalModelStore
}

/** Backend sessions rebind remote transports without replacing the phone's IPC. */
export function useMobileRuntimeSession(
  config: RuntimeSessionConfig | null,
  userId: number,
  localOptions: MobileLocalRuntimeOptions | undefined,
  inventory: RefObject<DeviceInfo[]>
) {
  const token = useRef(config?.accessToken ?? '')
  token.current = config?.accessToken ?? ''
  const local = localOptions?.runtime
  const localApi = useMemo(
    () =>
      local
        ? new LocalRuntimeApi(
            local,
            config,
            () => token.current,
            PHONE_LOCAL_USER,
            localOptions?.models
          )
        : undefined,
    [local, localOptions?.models]
  )
  const stream = useMemo(() => new RuntimeStream(config, () => inventory.current, local), [local])
  const cloudConnection = useSyncExternalStore(
    stream.subscribeCloudConnection,
    stream.getCloudConnection
  )
  const api = useMemo(
    () => new RuntimeApi(config, undefined, () => token.current, stream, localApi),
    [stream, localApi]
  )
  const localCache = useMemo(
    () => (local ? MobileRuntimeCache.local(local.accountScope) : null),
    [local]
  )
  const cloudCache = useMemo(
    () => (config ? new MobileRuntimeCache(config.apiBaseUrl, userId) : null),
    [config?.apiBaseUrl, userId]
  )
  const cache = useMemo(
    () => new RuntimeSessionCache(localCache, cloudCache, local?.accountScope),
    [localCache, cloudCache, local]
  )
  api.updateBackend(config, userId)
  localApi?.updateBackend(config, userId)
  useLayoutEffect(() => {
    stream.updateBackend(config, userId)
  }, [
    stream,
    config?.apiBaseUrl,
    config?.socketBaseUrl,
    config?.socketPath,
    config?.accessToken,
    userId,
  ])
  return { api, stream, cache, local, cloudConnection }
}
