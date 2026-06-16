import { useEffect, useState, type ReactNode } from 'react'
import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { getRuntimeConfig } from '@/config/runtime'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { DeviceOnboardingPage } from './DeviceOnboardingPage'
import { hasOnlineDevice } from './useDeviceOnboarding'

type GateStatus = 'checking' | 'onboarding' | 'ready'

interface DeviceOnboardingGateProps {
  children: ReactNode
}

// Gates native workbench routes on the desktop app: when the user has no online
// device, an onboarding page creates a local device (and optionally a cloud one)
// before the main UI renders.
export function DeviceOnboardingGate({ children }: DeviceOnboardingGateProps) {
  const [status, setStatus] = useState<GateStatus>(() => (isTauriRuntime() ? 'checking' : 'ready'))

  useEffect(() => {
    if (status !== 'checking') return
    let cancelled = false

    const { apiBaseUrl } = getRuntimeConfig()
    const deviceApi = createDeviceApi(createHttpClient({ baseUrl: apiBaseUrl }))

    deviceApi
      .listDevices()
      .then(devices => {
        if (cancelled) return
        setStatus(hasOnlineDevice(devices) ? 'ready' : 'onboarding')
      })
      .catch(() => {
        if (cancelled) return
        setStatus('onboarding')
      })

    return () => {
      cancelled = true
    }
  }, [status])

  if (status === 'checking') return null
  if (status === 'onboarding') {
    return <DeviceOnboardingPage onReady={() => setStatus('ready')} />
  }
  return <>{children}</>
}
