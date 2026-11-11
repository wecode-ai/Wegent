import { useEffect, useState } from 'react'
import { harnessAppsApi } from '@/api/local/harnessApps'
import {
  beginHarnessAppLaunch,
  clearHarnessAppLaunch,
  failHarnessAppLaunch,
} from './harnessAppLaunchState'
import { registerHarnessAppTab } from './harnessAppTabs'
import { notifyHarnessAppInstallationsChanged } from './harnessAppInstallationsChanged'
import { useTranslation } from '@/hooks/useTranslation'
import { getSmartAppErrorMessage } from '@/lib/smart-app-error-message'
import { isElectronRuntime } from '@/lib/runtime-environment'

interface HarnessAppAutoLauncherProps {
  installationId: string
  onStartupSettled?: (installationId: string) => void
}

/** The Host owns the runtime and its routes; a renderer only attaches a presentation. */
export function HarnessAppAutoLauncher({
  installationId,
  onStartupSettled,
}: HarnessAppAutoLauncherProps) {
  const { t } = useTranslation('common')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let disposed = false
    beginHarnessAppLaunch(installationId, t('workbench.smart_apps_title', '工作台'), () =>
      setAttempt(value => value + 1)
    )
    void (async () => {
      if (disposed) return
      const running = await harnessAppsApi.open(installationId, 'tab')
      if (disposed) return
      if (!running.webUrl)
        throw new Error(t('workbench.smart_apps_missing_web_url', '工作台没有返回可用地址'))
      registerHarnessAppTab(running)
      notifyHarnessAppInstallationsChanged({
        type: 'updated',
        installationId,
        installation: running,
      })
      if (isElectronRuntime()) clearHarnessAppLaunch(installationId)
    })()
      .catch(error => {
        if (!disposed)
          failHarnessAppLaunch(
            installationId,
            getSmartAppErrorMessage(
              error,
              t('workbench.smart_apps_launch_failed', '工作台启动失败'),
              t
            )
          )
      })
      .finally(() => {
        if (!disposed) onStartupSettled?.(installationId)
      })
    return () => {
      disposed = true
    }
  }, [attempt, installationId, onStartupSettled, t])

  return null
}
