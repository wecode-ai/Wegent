import { useEffect, useState } from 'react'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isDesktopRuntime } from '@/lib/runtime-environment'

export function useAppVersion(): string | null {
  const isDesktopApp = isDesktopRuntime()
  const [version, setVersion] = useState<string | null>(
    isDesktopApp ? null : __WEWORK_APP_VERSION__
  )

  useEffect(() => {
    if (!isDesktopApp) return

    let active = true
    const versionRequest = invokeDesktopHost<{ version: string }>('app.getVersion').then(
      result => result.version
    )
    void versionRequest
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
