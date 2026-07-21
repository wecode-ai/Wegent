import { Loader2, Monitor } from 'lucide-react'

import type { CloudDesktopWorkspaceActionProps } from '@/extensions/cloud-desktop-contract'
import { useTranslation } from '@/hooks/useTranslation'
import { useCloudDesktopLaunch } from './useCloudDesktopLaunch'

export function WorkspaceDesktopAction({
  testIdsEnabled = true,
  ...props
}: CloudDesktopWorkspaceActionProps) {
  const { t } = useTranslation('common')
  const launch = useCloudDesktopLaunch({
    ...props,
    failureMessage: t('workbench.project_tool_start_failed', '启动失败'),
  })

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
      <span className="text-sm font-semibold text-text-primary">
        {t('workbench.desktop', '桌面')}
      </span>
      <span className="mt-2 text-sm leading-[18px] text-text-secondary">
        {t('workbench.open_project_desktop', '打开项目桌面')}
      </span>
    </button>
  )
}
