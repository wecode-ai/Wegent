import { Tooltip } from '@/components/ui/tooltip'
import { getRuntimeConfig } from '@/config/runtime'
import { useOptionalAppUpdate } from '@/features/app-update/app-update-context'
import type { AppUpdateError } from '@/features/app-update/app-update-error'
import { AppUpdateErrorDetailsDialog } from '@/features/app-update/AppUpdateErrorDetailsDialog'
import { formatAppUpdateErrorSummary } from '@/features/app-update/app-update-error-copy'
import { calculateAppUpdateDownloadPercent } from '@/features/app-update/app-update-format'
import { formatAppUpdateProgress } from '@/features/app-update/app-update-progress-copy'
import { isCloudConnectionUiAvailable } from '@/features/cloud-connection/cloudConnectionAvailability'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { CloudConnectionDialog } from '@/features/cloud-connection/CloudConnectionDialog'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { User as UserProfile } from '@/types/api'
import { Popover, PopoverContent, PopoverTrigger } from '@wegent/collaboration/controls/Popover'
import { ProgressRing } from '@wegent/collaboration/controls/ProgressBar'
import { controlPopup } from '@wegent/collaboration/controls/recipes'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useCollaborationPortalTheme } from '@wegent/collaboration/theme'
import { Download, Loader2, UserRound } from 'lucide-react'
import { useContext, useRef, useState, type ReactNode, type RefObject } from 'react'
import { DesktopSettingsMenu } from './DesktopSettingsMenu'

export interface DesktopSidebarAccountSettingsOptions {
  autoOpenAddCloudDeviceDialog?: boolean
  settingsPage?: 'about' | 'connections' | 'execution-environments'
}

interface DesktopSidebarAccountProps {
  user: UserProfile | null
  onOpenSettings: (options?: DesktopSidebarAccountSettingsOptions) => void
  onLogout: () => void
  containerRef?: RefObject<HTMLDivElement | null>
  trailingActions?: ReactNode
  compact?: boolean
}

function getSidebarAccountSummary(user: UserProfile | null, fallback: string) {
  const userName = user?.user_name?.trim()
  const email = user?.email?.trim()
  const label = userName || email || fallback
  const detail = email && email !== label ? email : fallback
  return {
    label,
    detail,
  }
}

function formatSidebarTemplate(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    template
  )
}

function SidebarAppUpdateButton({ onBeforeInstall }: { onBeforeInstall?: () => void }) {
  const { t } = useTranslation('common')
  const appUpdate = useOptionalAppUpdate()
  const availableUpdate = appUpdate?.availableUpdate ?? null
  const status = appUpdate?.status ?? 'idle'
  const downloadProgress = appUpdate?.downloadProgress ?? null
  const error = appUpdate?.error ?? null
  const errorSummary = error ? formatAppUpdateErrorSummary(error, t) : null
  const busy = status === 'checking' || status === 'downloading' || status === 'installing'
  const downloadPercent = downloadProgress
    ? calculateAppUpdateDownloadPercent(
        downloadProgress.downloadedBytes,
        downloadProgress.totalBytes
      )
    : null

  if (!appUpdate || !availableUpdate) return null

  const title = formatSidebarTemplate(
    t('workbench.app_update_install', {
      defaultValue: '更新到 {{version}}',
      version: availableUpdate.version,
    }),
    { version: availableUpdate.version }
  )
  const downloadTitle = formatAppUpdateProgress(downloadProgress, t)
  const actionLabel = status === 'downloading' ? downloadTitle : title
  const button = (
    <ControlButton
      variant="unstyled"
      type="button"
      data-testid="sidebar-app-update-button"
      disabled={busy}
      onClick={() => {
        onBeforeInstall?.()
        void appUpdate.installUpdate()
      }}
      aria-label={errorSummary ?? actionLabel}
      className={cn(
        'group relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        errorSummary
          ? 'text-destructive hover:bg-destructive/10 wework:text-red-500 wework:hover:bg-red-500/10'
          : 'text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]'
      )}
    >
      {status === 'downloading' && downloadPercent !== null ? (
        <ProgressRing
          value={downloadPercent}
          label={t('workbench.app_update_downloading_progress', { progress: downloadPercent })}
          testId="sidebar-app-update-download-progress"
        />
      ) : busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Download className="sidebar-update-download-icon h-4 w-4" />
      )}
      {!busy && (
        <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary ring-2 ring-[rgb(var(--color-sidebar-hover))]" />
      )}
      {errorSummary && (
        <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-destructive ring-2 ring-[rgb(var(--color-sidebar-hover))] wework:bg-red-500" />
      )}
    </ControlButton>
  )

  return (
    <Tooltip
      label={errorSummary ?? actionLabel}
      testId={errorSummary ? 'sidebar-app-update-error' : 'sidebar-app-update-tooltip'}
      className={errorSummary ? 'text-destructive' : undefined}
    >
      <span className="inline-flex shrink-0" tabIndex={busy ? 0 : undefined}>
        {button}
      </span>
    </Tooltip>
  )
}

export function DesktopSidebarAccount({
  user,
  onOpenSettings,
  onLogout,
  containerRef: containerRefProp,
  trailingActions,
  compact = false,
}: DesktopSidebarAccountProps) {
  const { t } = useTranslation('common')
  const portalTheme = useCollaborationPortalTheme()
  const cloudContext = useContext(CloudConnectionContext)
  const cloud = useOptionalCloudConnection()
  const appUpdate = useOptionalAppUpdate()
  const usesCloudAccount =
    (isCloudConnectionUiAvailable() && Boolean(getRuntimeConfig().wegentBackendUrl)) ||
    Boolean(cloudContext?.isConnected && cloudContext.backendUrl)
  const requiresCloudLogin = usesCloudAccount && !cloud.isConnected
  const hasAvailableAppUpdate = Boolean(appUpdate?.availableUpdate)
  const account = requiresCloudLogin
    ? {
        label: t('workbench.account_cloud_title', 'Wegent 账户'),
        detail: t('workbench.account_not_logged_in', '未登录'),
      }
    : getSidebarAccountSummary(
        usesCloudAccount ? cloud.user : user,
        t('workbench.account_fallback', '当前账号')
      )
  const [menuOpen, setMenuOpen] = useState(false)
  const [updateFailure, setUpdateFailure] = useState<{
    error: AppUpdateError
    retry: () => Promise<void>
  } | null>(null)
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false)
  const internalContainerRef = useRef<HTMLDivElement>(null)
  const containerRef = containerRefProp ?? internalContainerRef

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <div
          ref={containerRef}
          data-testid="desktop-sidebar-account"
          className="group/account relative shrink-0"
        >
          <div
            className={cn(
              'relative flex items-center transition-colors group-hover/account:bg-[rgb(var(--color-sidebar-hover))] group-focus-within/account:bg-[rgb(var(--color-sidebar-hover))]',
              compact ? 'h-7 rounded-lg' : 'h-[60px] rounded-[10px]'
            )}
          >
            <PopoverTrigger
              render={
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="settings-button"
                  className={cn(
                    'flex min-w-0 flex-1 items-center text-left text-[rgb(var(--color-sidebar-text-primary))]',
                    compact
                      ? 'h-7 w-7 justify-center rounded-lg'
                      : cn(
                          'h-[60px] gap-3 rounded-[10px] py-2 pl-1.5',
                          hasAvailableAppUpdate ? 'pr-[72px]' : 'pr-10'
                        )
                  )}
                  title={t('workbench.account_and_settings', '账户与设置')}
                  aria-label={t('workbench.account_and_settings', '账户与设置')}
                  aria-expanded={menuOpen}
                />
              }
            >
              <span
                data-testid="sidebar-account-avatar"
                className={cn(
                  'flex shrink-0 items-center justify-center rounded-full',
                  compact
                    ? 'h-7 w-7 bg-muted text-text-secondary'
                    : 'h-10 w-10 bg-primary/20 text-primary'
                )}
              >
                <UserRound className={compact ? 'h-4 w-4' : 'h-5 w-5'} aria-hidden="true" />
              </span>
              {!compact ? (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-semibold leading-[18px]">
                    {account.label}
                  </span>
                  <span className="block truncate text-xs font-medium leading-4 text-[rgb(var(--color-sidebar-text-secondary))]">
                    {account.detail}
                  </span>
                </span>
              ) : null}
            </PopoverTrigger>
            {!compact ? (
              <div
                className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5"
                onClickCapture={() => setMenuOpen(false)}
              >
                {hasAvailableAppUpdate && (
                  <div data-testid="sidebar-app-update-action">
                    <SidebarAppUpdateButton onBeforeInstall={() => setMenuOpen(false)} />
                  </div>
                )}
                {trailingActions}
              </div>
            ) : null}
            <PopoverContent
              {...portalTheme}
              aria-label={t('workbench.account_and_settings', '账户与设置')}
              side={compact ? 'bottom' : 'top'}
              align={compact ? 'end' : 'start'}
              sideOffset={8}
              collisionPadding={8}
              className={cn(portalTheme.className, controlPopup, 'w-72')}
            >
              <DesktopSettingsMenu
                user={user}
                showLogout={usesCloudAccount ? cloud.isConnected : undefined}
                onShowUpdateError={(error, retry) => {
                  setMenuOpen(false)
                  setUpdateFailure({ error, retry })
                }}
                onOpenSettings={() => {
                  setMenuOpen(false)
                  onOpenSettings()
                }}
                onOpenAbout={() => {
                  setMenuOpen(false)
                  onOpenSettings({ settingsPage: 'about' })
                }}
                onLogin={
                  requiresCloudLogin
                    ? () => {
                        setMenuOpen(false)
                        setCloudDialogOpen(true)
                      }
                    : undefined
                }
                onLogout={() => {
                  setMenuOpen(false)
                  if (usesCloudAccount) {
                    cloud.disconnect()
                    return
                  }
                  onLogout()
                }}
              />
            </PopoverContent>
          </div>
        </div>
      </Popover>

      {updateFailure && (
        <AppUpdateErrorDetailsDialog
          open
          error={updateFailure.error}
          onClose={() => setUpdateFailure(null)}
          onRetry={async () => {
            setUpdateFailure(null)
            await updateFailure.retry()
          }}
        />
      )}

      {cloudDialogOpen && (
        <CloudConnectionDialog
          open
          onlineCloudDeviceCount={0}
          onClose={() => setCloudDialogOpen(false)}
          onOpenSettings={() => {
            setCloudDialogOpen(false)
            onOpenSettings({ settingsPage: 'connections' })
          }}
        />
      )}
    </>
  )
}
