import { useCallback, useEffect } from 'react'
import { Monitor } from 'lucide-react'

import { DeviceActionButton } from '@/components/settings/DeviceActionButton'
import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { deviceDesktopRoute } from '@/pages/deviceDesktopRoute'
import type {
  CloudDesktopActionProps,
  CloudDesktopLaunchOptions,
  CloudDesktopWorkspaceActionProps,
} from './cloud-desktop-contract'

function useOpenDeviceDesktop(deviceId: string, onOpened: () => void) {
  const { t } = useTranslation('common')
  const workspaceTabs = useOptionalWorkspaceTabs()
  const title = t('workbench.device_desktop')
  const route = deviceDesktopRoute(deviceId)

  return useCallback(
    async (options: CloudDesktopLaunchOptions = {}) => {
      if (workspaceTabs) {
        const existing = workspaceTabs.tabs.find(tab => tab.contentRoute === route)
        if (existing) {
          workspaceTabs.selectTab(existing.id, { title, contentRoute: route })
        } else {
          workspaceTabs.openTab('auxiliary', { title, contentRoute: route })
        }
      } else {
        navigateTo(route)
      }
      if (options.notifyOpened !== false) onOpened()
    },
    [onOpened, route, title, workspaceTabs]
  )
}

export function CloudDesktopDeviceAction({
  deviceId,
  disabled,
  onOpened,
}: CloudDesktopActionProps) {
  const { t } = useTranslation('common')
  const openDesktop = useOpenDeviceDesktop(deviceId, onOpened)

  return (
    <DeviceActionButton
      testId={`connection-vnc-desktop-button-${deviceId}`}
      icon={Monitor}
      label={t('workbench.device_desktop')}
      onClick={() => void openDesktop()}
      disabled={disabled}
      title={disabled ? t('workbench.device_desktop_unavailable') : undefined}
    />
  )
}

export function CloudDesktopWorkspaceAction({
  contextKey,
  deviceId,
  disabled,
  onBusyChange,
  onErrorChange,
  onLaunchActionChange,
  onOpened,
  testIdsEnabled,
}: CloudDesktopWorkspaceActionProps) {
  const { t } = useTranslation('common')
  const openDesktop = useOpenDeviceDesktop(deviceId, onOpened)

  const launch = useCallback(
    async (options?: CloudDesktopLaunchOptions) => {
      if (disabled) return
      onBusyChange(true)
      try {
        await openDesktop(options)
        onErrorChange(null)
      } catch {
        onErrorChange(t('workbench.device_desktop_session_failed'))
      } finally {
        onBusyChange(false)
      }
    },
    [disabled, onBusyChange, onErrorChange, openDesktop, t]
  )

  useEffect(() => {
    onLaunchActionChange?.(launch)
    return () => onLaunchActionChange?.(null)
  }, [launch, onLaunchActionChange])

  return (
    <button
      type="button"
      data-testid={testIdsEnabled ? 'workspace-vnc-desktop-card' : undefined}
      data-context-key={contextKey}
      onClick={() => void launch()}
      disabled={disabled}
      title={disabled ? t('workbench.device_desktop_unavailable') : undefined}
      className="flex min-h-32 flex-col items-center justify-center rounded-lg bg-surface text-center hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Monitor className="mb-5 h-7 w-7 text-text-secondary" aria-hidden="true" />
      <span className="text-sm font-semibold text-text-primary">
        {t('workbench.device_desktop')}
      </span>
      <span className="mt-2 text-sm text-text-secondary">{t('workbench.device_desktop_open')}</span>
    </button>
  )
}
