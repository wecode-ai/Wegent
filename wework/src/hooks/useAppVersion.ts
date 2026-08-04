import { getVersion } from '@tauri-apps/api/app'
import { useEffect, useState } from 'react'
import { isTauriRuntime } from '@/lib/runtime-environment'

export function useAppVersion(): string | null {
  const isDesktopApp = isTauriRuntime()
  const [version, setVersion] = useState<string | null>(
    isDesktopApp ? null : __WEWORK_APP_VERSION__
  )

  useEffect(() => {
    if (!isDesktopApp) return

    let active = true
    void getVersion()
      .then(appVersion => {
        if (active) setVersion(appVersion)
      })
      .catch(error => {
        console.error('Failed to read the Wework app version', error)
      })

    return () => {
      active = false
    }
  }, [isDesktopApp])

  return version
}
