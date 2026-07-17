import { memo, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertCircle, Loader2, PanelBottom, PanelRight } from 'lucide-react'
import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import {
  supportsCloudSessions,
  supportsLocalTerminalLaunch,
  supportsRemoteSessions,
} from '@/lib/device-capabilities'
import {
  DEFAULT_LOCAL_WORKSPACE_OPENER_ID,
  type LocalWorkspaceOpenerId,
} from '@/lib/local-workspace-openers'
import { isLocalTerminalAvailable, openLocalWorkspace } from '@/lib/local-terminal'
import { configuredWorkspacePath } from '@/lib/project-workspace'
import { getProjectDeviceId } from '@/lib/workbench-device'
import { EnvironmentInfoPopover } from '../EnvironmentInfoPopover'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from '../DesktopTopBar'
import { TitlebarTooltip } from '@/components/topnav/TitlebarTooltip'
import { openExternalUrl } from '@/lib/external-links'
import { cn } from '@/lib/utils'
import { LocalWorkspaceOpenerIcon, LocalWorkspaceOpenerPicker } from './LocalWorkspaceOpenerMenu'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import type { WorkspaceTarget } from '@/types/workspace-files'

interface WorkspacePanelActionsProps {
  mode?:
    | 'all'
    | 'environment'
    | 'primary-target'
    | 'panel-toggles'
    | 'bottom-panel-toggle'
    | 'right-panel-toggle'
  currentProject?: ProjectWithTasks | null
  devices?: DeviceInfo[]
  workspaceTarget?: WorkspaceTarget | null
  workspaceSessionApi?: WorkspaceSessionApi
  environmentInfo: EnvironmentInfo
  environmentInfoPopoverContainer: HTMLElement | null
  environmentInfoVisible?: boolean
  environmentInfoDocked?: boolean
  environmentInfoOpen: boolean
  onEnvironmentInfoOpenChange: (open: boolean) => void
  environmentInfoFloatingFooter?: ReactNode
  onRefreshEnvironmentInfo: () => Promise<void>
  onCommitEnvironmentChanges: (message: string) => Promise<void>
  onCommitAndPushEnvironmentChanges: (message: string) => Promise<void>
  onPushEnvironmentChanges: () => Promise<void>
  onListEnvironmentBranches: () => Promise<string[]>
  onCheckoutEnvironmentBranch: (branchName: string) => Promise<void>
  onCreateEnvironmentBranch: (branchName: string) => Promise<void>
  onOpenEnvironmentChangesReview: () => void
  rightPanelOpen: boolean
  bottomPanelOpen: boolean
  onToggleRightPanel: () => void
  onToggleBottomPanel: () => void
}

export const WorkspacePanelActions = memo(function WorkspacePanelActions({
  mode = 'all',
  currentProject = null,
  devices = [],
  workspaceTarget = null,
  workspaceSessionApi,
  environmentInfo,
  environmentInfoPopoverContainer,
  environmentInfoVisible = true,
  environmentInfoDocked = true,
  environmentInfoOpen,
  onEnvironmentInfoOpenChange,
  environmentInfoFloatingFooter,
  onRefreshEnvironmentInfo,
  onCommitEnvironmentChanges,
  onCommitAndPushEnvironmentChanges,
  onPushEnvironmentChanges,
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
  const [ideLoading, setIdeLoading] = useState(false)
  const [ideError, setIdeError] = useState<string | null>(null)
  const showEnvironmentInfo = environmentInfoVisible && (mode === 'all' || mode === 'environment')
  const showPrimaryTarget = mode === 'all' || mode === 'primary-target'
  const showBottomPanelToggle =
    mode === 'all' || mode === 'panel-toggles' || mode === 'bottom-panel-toggle'
  const showRightPanelToggle =
    mode === 'all' || mode === 'panel-toggles' || mode === 'right-panel-toggle'
  const codeServerProjectDeviceId = workspaceTarget?.deviceId ?? getProjectDeviceId(currentProject)
  const canOpenCodeServer = Boolean(
    codeServerProjectDeviceId && (currentProject || workspaceTarget)
  )
  const codeServerDevice = codeServerProjectDeviceId
    ? devices.find(device => device.device_id === codeServerProjectDeviceId)
    : undefined
  const remoteWorkspaceSession = Boolean(
    workspaceTarget?.workspaceSource === 'remote' ||
    (codeServerDevice &&
      (supportsCloudSessions(codeServerDevice) || supportsRemoteSessions(codeServerDevice)))
  )
  const useDeviceCodeServerSession = Boolean(remoteWorkspaceSession && workspaceTarget)
  const codeServerEnabled = Boolean(
    workspaceSessionApi &&
    codeServerDevice &&
    (supportsCloudSessions(codeServerDevice) || supportsRemoteSessions(codeServerDevice))
  )
  const localWorkspacePath =
    workspaceTarget?.path ?? (currentProject ? configuredWorkspacePath(currentProject) : undefined)
  const projectUsesLocalWorkspace = Boolean(
    currentProject &&
    (currentProject.config?.execution?.targetType === 'local' ||
      currentProject.config?.workspace?.source === 'local_path')
  )
  const localWorkspaceEnabled = Boolean(
    !remoteWorkspaceSession &&
    localWorkspacePath?.trim() &&
    isLocalTerminalAvailable() &&
    (projectUsesLocalWorkspace ||
      (codeServerDevice && supportsLocalTerminalLaunch(codeServerDevice)))
  )
  const ideTitle = localWorkspaceEnabled
    ? t('workbench.open_project_ide_with', {
        opener: 'VS Code',
      })
    : codeServerEnabled
      ? t('workbench.open_project_ide')
      : t('workbench.project_ide_cloud_only_tooltip')
  const bottomPanelTitle = t('workbench.toggle_bottom_workspace_panel')
  const rightPanelTitle = t('workbench.toggle_right_workspace_panel')

  const getStartFailedMessage = (error: unknown) => {
    if (error instanceof Error && error.message) {
      return error.message
    }
    return t('workbench.project_ide_start_failed_message')
  }

  const handleOpenCodeServer = async () => {
    const workspacePath = localWorkspacePath?.trim()
    if (
      !codeServerProjectDeviceId ||
      !workspaceSessionApi ||
      ideLoading ||
      !codeServerEnabled ||
      (useDeviceCodeServerSession && !workspacePath)
    ) {
      return
    }
    setIdeLoading(true)
    setIdeError(null)
    try {
      const session = useDeviceCodeServerSession
        ? await workspaceSessionApi.startDeviceCodeServer(codeServerProjectDeviceId, workspacePath)
        : currentProject
          ? await workspaceSessionApi.startProjectCodeServer(currentProject.id)
          : null
      if (!session) {
        throw new Error('IDE session target is missing')
      }
      if (!session.url) {
        throw new Error('IDE session URL is missing')
      }
      await openExternalUrl(session.url)
    } catch (error) {
      console.error('Failed to start project IDE:', error)
      setIdeError(getStartFailedMessage(error))
    } finally {
      setIdeLoading(false)
    }
  }

  const handleOpenLocalWorkspace = async (
    opener: LocalWorkspaceOpenerId = DEFAULT_LOCAL_WORKSPACE_OPENER_ID
  ) => {
    if (!localWorkspacePath || ideLoading || !localWorkspaceEnabled) return
    setIdeLoading(true)
    setIdeError(null)
    try {
      await openLocalWorkspace({
        opener,
        path: localWorkspacePath,
      })
    } catch (error) {
      console.error('Failed to open local workspace:', error)
      setIdeError(getStartFailedMessage(error))
    } finally {
      setIdeLoading(false)
    }
  }

  return (
    <>
      {showEnvironmentInfo && (
        <EnvironmentInfoPopover
          key={environmentInfoDocked ? 'docked' : 'floating'}
          info={environmentInfo}
          popoverContainer={environmentInfoPopoverContainer}
          docked={environmentInfoDocked}
          open={environmentInfoOpen}
          onOpenChange={onEnvironmentInfoOpenChange}
          floatingFooter={environmentInfoFloatingFooter}
          devices={devices}
          onRefresh={onRefreshEnvironmentInfo}
          onCommitChanges={onCommitEnvironmentChanges}
          onCommitAndPushChanges={onCommitAndPushEnvironmentChanges}
          onPushChanges={onPushEnvironmentChanges}
          onListBranches={onListEnvironmentBranches}
          onCheckoutBranch={onCheckoutEnvironmentBranch}
          onCreateBranch={onCreateEnvironmentBranch}
          onOpenChangesReview={onOpenEnvironmentChangesReview}
        />
      )}
      {showPrimaryTarget && canOpenCodeServer && localWorkspaceEnabled && (
        <div
          data-testid="local-workspace-titlebar-control"
          className={cn(
            'group inline-flex h-8 shrink-0 items-center overflow-hidden rounded-[14px] border border-border/60 bg-background text-[#6b7280] transition-colors hover:border-border/80 hover:bg-background focus-within:ring-2 focus-within:ring-primary/25',
            ideLoading && 'cursor-wait opacity-70'
          )}
        >
          <button
            type="button"
            data-testid="open-code-server-titlebar-button"
            onClick={() => void handleOpenLocalWorkspace()}
            disabled={ideLoading}
            className={cn(
              'flex h-8 shrink-0 items-center gap-1.5 border-0 bg-transparent pl-2 pr-1.5 text-sm font-medium leading-[18px] text-text-primary transition-colors hover:bg-black/[0.06] hover:text-text-primary active:bg-black/[0.10] focus-visible:outline-none disabled:cursor-wait',
              ideLoading && 'cursor-wait opacity-70'
            )}
            aria-label={t('workbench.open_project_ide_with', {
              opener: 'VS Code',
            })}
            title={ideTitle}
          >
            {ideLoading ? (
              <Loader2 className="animate-spin" />
            ) : (
              <LocalWorkspaceOpenerIcon opener="vscode" className="h-4 w-4" />
            )}
            <span className="whitespace-nowrap">{t('workbench.open_workspace_location')}</span>
          </button>
          <LocalWorkspaceOpenerPicker
            ariaLabel={t('workbench.choose_project_ide')}
            buttonTestId="open-local-workspace-picker-button"
            menuTestId="open-local-workspace-picker-menu"
            optionTestIdPrefix="open-local-workspace-option"
            disabled={ideLoading}
            buttonClassName={cn(
              'flex h-8 w-7 shrink-0 items-center justify-center border-0 bg-transparent p-0 text-[#6b7280] transition-colors hover:bg-black/[0.06] hover:text-[#374151] active:bg-black/[0.10] focus-visible:outline-none disabled:cursor-wait [&_svg]:h-4 [&_svg]:w-4 [&_svg]:stroke-[2]',
              ideLoading && 'cursor-wait opacity-70'
            )}
            onSelect={handleOpenLocalWorkspace}
          />
        </div>
      )}
      {showPrimaryTarget && canOpenCodeServer && !localWorkspaceEnabled && (
        <button
          type="button"
          data-testid="open-code-server-titlebar-button"
          onClick={() => void handleOpenCodeServer()}
          disabled={ideLoading || !codeServerEnabled}
          className={cn(
            DESKTOP_TOP_BAR_BUTTON_CLASS,
            !codeServerEnabled && 'cursor-not-allowed opacity-45',
            ideLoading && 'cursor-wait opacity-70'
          )}
          aria-label={t('workbench.open_project_ide')}
          title={ideTitle}
        >
          {ideLoading ? (
            <Loader2 className="animate-spin" />
          ) : (
            <LocalWorkspaceOpenerIcon opener="vscode" className="h-[18px] w-[18px]" />
          )}
        </button>
      )}
      {ideError && <CodeServerErrorDialog message={ideError} onClose={() => setIdeError(null)} />}
      {(showBottomPanelToggle || showRightPanelToggle) && (
        <>
          {showBottomPanelToggle && (
            <TitlebarTooltip
              label={t('workbench.toggle_bottom_workspace_panel_visible', '切换底部面板显示')}
              shortcut="Command+J"
              align="end"
            >
              <button
                type="button"
                data-testid="toggle-bottom-workspace-panel-button"
                onClick={onToggleBottomPanel}
                className={cn(
                  DESKTOP_TOP_BAR_BUTTON_CLASS,
                  bottomPanelOpen && 'bg-black/[0.10] text-[#374151]'
                )}
                aria-label={bottomPanelTitle}
              >
                <PanelBottom />
              </button>
            </TitlebarTooltip>
          )}
          {showRightPanelToggle && (
            <TitlebarTooltip label={rightPanelTitle} shortcut="Alt+Command+B" align="end">
              <button
                type="button"
                data-testid="toggle-right-workspace-panel-button"
                onClick={onToggleRightPanel}
                className={cn(
                  DESKTOP_TOP_BAR_BUTTON_CLASS,
                  rightPanelOpen && 'bg-black/[0.10] text-[#374151]'
                )}
                aria-label={rightPanelTitle}
              >
                <PanelRight />
              </button>
            </TitlebarTooltip>
          )}
        </>
      )}
    </>
  )
})

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
