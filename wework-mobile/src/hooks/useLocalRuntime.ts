import { requireOptionalNativeModule } from 'expo'
import { useCallback, useEffect, useState } from 'react'
import { AppState } from 'react-native'
import {
  LocalRuntime,
  UNAVAILABLE_LOCAL_RUNTIME,
  type LocalRuntimeProfile,
  type NativeLocalRuntime,
} from '@/services/localRuntime'
import {
  loadPhoneLocalProfile,
  LocalProfileSelectionRequired,
  selectPhoneLocalProfile,
} from '@/services/phoneLocalProfile'

const native = requireOptionalNativeModule<NativeLocalRuntime>('WeworkLocalRuntime')

export function useLocalRuntime() {
  const [runtime, setRuntime] = useState<LocalRuntime | null>(null)
  const [status, setStatus] = useState({ ...UNAVAILABLE_LOCAL_RUNTIME, supported: Boolean(native) })
  const [error, setError] = useState<unknown>(null)
  const [profiles, setProfiles] = useState<LocalRuntimeProfile[]>([])
  const [selectingProfile, setSelectingProfile] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(async () => {
    if (runtime) {
      try {
        await runtime.start()
        if (native) setProfiles(await native.listProfilesAsync())
        setError(null)
      } catch (cause) {
        setError(cause)
        throw cause
      }
      return
    }
    setAttempt(value => value + 1)
  }, [runtime])
  const selectProfile = useCallback(
    async (scope: string) => {
      if (!native) throw new Error('此安装包不含手机本地执行环境')
      setSelectingProfile(true)
      try {
        if (runtime) await runtime.stop()
        await selectPhoneLocalProfile(native, scope)
        setRuntime(null)
        setStatus({ ...UNAVAILABLE_LOCAL_RUNTIME, supported: true })
        setError(null)
        setAttempt(value => value + 1)
      } catch (cause) {
        setError(cause)
        throw cause
      } finally {
        setSelectingProfile(false)
      }
    },
    [runtime]
  )

  useEffect(() => {
    let active = true
    let instance: LocalRuntime | null = null
    let unsubscribe: (() => void) | undefined
    let foreground: { remove(): void } | undefined
    const observe = async (operation: Promise<void>) => {
      try {
        await operation
        if (active) setError(null)
      } catch (cause) {
        if (active) {
          setError(cause)
          if (cause instanceof LocalProfileSelectionRequired) setProfiles(cause.profiles)
        }
      }
    }
    void observe(
      (async () => {
        const scope = await loadPhoneLocalProfile(native)
        if (!active) return
        instance = new LocalRuntime(native, scope)
        setRuntime(instance)
        unsubscribe = instance.onStatus(() => {
          if (active) setStatus(instance!.status)
        })
        foreground = AppState.addEventListener('change', state => {
          if (state === 'active' && instance) void observe(instance.recover())
        })
        await instance.initialize()
        if (!active) return
        setStatus(instance.status)
        if (instance.status.supported) await instance.start()
        if (native && active) setProfiles(await native.listProfilesAsync())
      })()
    )
    return () => {
      active = false
      unsubscribe?.()
      foreground?.remove()
      instance?.dispose()
    }
  }, [attempt])
  return { runtime, status, error, retry, profiles, selectProfile, selectingProfile }
}
