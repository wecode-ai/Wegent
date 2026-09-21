import { Loader2, Monitor } from 'lucide-react'
import { useEffect } from 'react'

import type { DeviceSurfaceWorkspaceActionProps } from '@/extensions/device-surface-contract'
import { useTranslation } from '@/hooks/useTranslation'
import { useCloudDesktopLaunch } from './useCloudDesktopLaunch'

export function WorkspaceDesktopAction({
  onLaunchActionChange,
  testIdsEnabled = true,
  ...props
}: DeviceSurfaceWorkspaceActionProps) {
  const { t } = useTranslation('vnc')
  const launch = useCloudDesktopLaunch({
    ...props,
    failureMessage: t('open_project_desktop_failed', '启动失败'),
    target: 'embedded',
  })

  useEffect(() => {
    onLaunchActionChange?.(launch.open)
    return () => onLaunchActionChange?.(null)
  }, [launch.open, onLaunchActionChange])

  return (
    <button
      type="button"
      data-testid={testIdsEnabled ? 'workspace-desktop-card' : undefined}
      onClick={() => void launch.open()}
      disabled={launch.disabled}
      className="flex min-h-[132px] flex-col items-center justify-center rounded-lg bg-surface text-center hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      {launch.loading ? (
        <Loader2 className="mb-5 h-7 w-7 animate-spin text-text-secondary" />
      ) : (
        <Monitor className="mb-5 h-7 w-7 text-text-secondary" />
      )}
      <span className="text-sm font-semibold text-text-primary">{t('desktop', '桌面')}</span>
      <span className="mt-2 text-sm leading-[18px] text-text-secondary">
        {t('open_project_desktop', '打开项目桌面')}
      </span>
    </button>
  )
}
