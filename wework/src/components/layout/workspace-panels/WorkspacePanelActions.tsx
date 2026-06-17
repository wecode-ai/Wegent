import { useMemo, useState } from 'react'
import { AlertCircle, Code2, Loader2, PanelBottom, PanelRight } from 'lucide-react'
import { createHttpClient } from '@/api/http'
import { createProjectApi } from '@/api/projects'
import { getRuntimeConfig } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import { isCloudDevice } from '@/lib/device-capabilities'
import { getProjectDeviceId } from '@/lib/workbench-device'
import { EnvironmentInfoPopover } from '../EnvironmentInfoPopover'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from '../DesktopTopBar'
import { cn } from '@/lib/utils'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'

interface WorkspacePanelActionsProps {
  mode?: 'all' | 'environment' | 'panel-toggles'
  currentProject?: ProjectWithTasks | null
  devices?: DeviceInfo[]
  environmentInfo: EnvironmentInfo
  onRefreshEnvironmentInfo: () => Promise<void>
  onCommitEnvironmentChanges: (message: string) => Promise<void>
  onListEnvironmentBranches: () => Promise<string[]>
  onCheckoutEnvironmentBranch: (branchName: string) => Promise<void>
  onCreateEnvironmentBranch: (branchName: string) => Promise<void>
  onOpenEnvironmentChangesReview: () => void
  rightPanelOpen: boolean
  bottomPanelOpen: boolean
  onToggleRightPanel: () => void
  onToggleBottomPanel: () => void
}

export function WorkspacePanelActions({
  mode = 'all',
  currentProject = null,
  devices = [],
  environmentInfo,
  onRefreshEnvironmentInfo,
  onCommitEnvironmentChanges,
  onListEnvironmentBranches,
  onCheckoutEnvironmentBranch,
  onCreateEnvironmentBranch,
  onOpenEnvironmentChangesReview,
  rightPanelOpen,
  bottomPanelOpen,
  onToggleRightPanel,
  onToggleBottomPanel,
}: WorkspacePanelActionsProps) {
  const { t } = useTranslation('common')
  const [codeServerLoading, setCodeServerLoading] = useState(false)
  const [codeServerError, setCodeServerError] = useState<string | null>(null)
  const showEnvironmentInfo = mode !== 'panel-toggles'
  const showPanelToggles = mode !== 'environment'
  const hasEnvironmentContext = Boolean(
    environmentInfo.branchName?.trim() ||
    environmentInfo.deviceId?.trim() ||
    environmentInfo.workspacePath?.trim() ||
    environmentInfo.error?.trim()
  )
  const canShowEnvironmentInfo = environmentInfo.loading !== false || hasEnvironmentContext
  const codeServerProjectDeviceId = getProjectDeviceId(currentProject)
  const canOpenCodeServer = Boolean(currentProject && codeServerProjectDeviceId)
  const codeServerDevice = codeServerProjectDeviceId
    ? devices.find(device => device.device_id === codeServerProjectDeviceId)
    : undefined
  const codeServerEnabled = Boolean(codeServerDevice && isCloudDevice(codeServerDevice))
  const codeServerTitle = codeServerEnabled
    ? t('workbench.open_project_ide')
    : t('workbench.project_ide_cloud_only_tooltip')
  const bottomPanelTitle = t('workbench.toggle_bottom_workspace_panel')
  const rightPanelTitle = t('workbench.toggle_right_workspace_panel')
  const projectApi = useMemo(() => {
    const { apiBaseUrl } = getRuntimeConfig()
    return createProjectApi(createHttpClient({ baseUrl: apiBaseUrl }))
  }, [])

  const getStartFailedMessage = (error: unknown) => {
    if (error instanceof Error && error.message) {
      return error.message
    }
    return t('workbench.project_ide_start_failed_message')
  }

  const handleOpenCodeServer = async () => {
    if (!currentProject || codeServerLoading || !codeServerEnabled) return
    setCodeServerLoading(true)
    setCodeServerError(null)
    try {
      const session = await projectApi.startCodeServerSession(currentProject.id)
      if (!session.url) {
        throw new Error('IDE session URL is missing')
      }
      window.open(session.url, '_blank', 'noopener')
    } catch (error) {
      console.error('Failed to start project IDE:', error)
      setCodeServerError(getStartFailedMessage(error))
    } finally {
      setCodeServerLoading(false)
    }
  }

  return (
    <>
      {showEnvironmentInfo && canShowEnvironmentInfo && (
        <EnvironmentInfoPopover
          info={environmentInfo}
          devices={devices}
          onRefresh={onRefreshEnvironmentInfo}
          onCommitChanges={onCommitEnvironmentChanges}
          onListBranches={onListEnvironmentBranches}
          onCheckoutBranch={onCheckoutEnvironmentBranch}
          onCreateBranch={onCreateEnvironmentBranch}
          onOpenChangesReview={onOpenEnvironmentChangesReview}
        />
      )}
      {showPanelToggles && canOpenCodeServer && (
        <button
          type="button"
          data-testid="open-code-server-titlebar-button"
          onClick={() => void handleOpenCodeServer()}
          disabled={codeServerLoading || !codeServerEnabled}
          className={cn(
            DESKTOP_TOP_BAR_BUTTON_CLASS,
            !codeServerEnabled && 'cursor-not-allowed opacity-45',
            codeServerLoading && 'cursor-wait opacity-70'
          )}
          aria-label={t('workbench.open_project_ide')}
          title={codeServerTitle}
        >
          {codeServerLoading ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Code2 className="text-[#007ACC]" />
          )}
        </button>
      )}
      {codeServerError && (
        <CodeServerErrorDialog message={codeServerError} onClose={() => setCodeServerError(null)} />
      )}
      {showPanelToggles && (
        <>
          <button
            type="button"
            data-testid="toggle-bottom-workspace-panel-button"
            onClick={onToggleBottomPanel}
            className={cn(
              DESKTOP_TOP_BAR_BUTTON_CLASS,
              bottomPanelOpen && 'bg-black/[0.10] text-[#374151]'
            )}
            aria-label={t('workbench.toggle_bottom_workspace_panel', '打开底部栏')}
            title={bottomPanelTitle}
          >
            <PanelBottom />
          </button>
          <button
            type="button"
            data-testid="toggle-right-workspace-panel-button"
            onClick={onToggleRightPanel}
            className={cn(
              DESKTOP_TOP_BAR_BUTTON_CLASS,
              rightPanelOpen && 'bg-black/[0.10] text-[#374151]'
            )}
            aria-label={t('workbench.toggle_right_workspace_panel', '打开右侧栏')}
            title={rightPanelTitle}
          >
            <PanelRight />
          </button>
        </>
      )}
    </>
  )
}

function CodeServerErrorDialog({ message, onClose }: { message: string; onClose: () => void }) {
  const { t } = useTranslation('common')

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        data-testid="code-server-error-dialog"
        className="w-full max-w-[420px] rounded-lg border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-red-500/10 text-red-500">
            <AlertCircle className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-text-primary">
              {t('workbench.project_ide_start_failed_title')}
            </h2>
            <p className="mt-1.5 text-xs leading-5 text-text-secondary">{message}</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            data-testid="close-code-server-error-dialog-button"
            onClick={onClose}
            className="h-8 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90"
          >
            {t('workbench.project_ide_error_close')}
          </button>
        </div>
      </div>
    </div>
  )
}
