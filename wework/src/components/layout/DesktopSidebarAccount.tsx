import { calculateAppUpdateDownloadPercent } from '@/features/app-update/app-update-format'
import { formatAppUpdateProgress } from '@/features/app-update/app-update-progress-copy'
import { Download, Loader2, UserRound } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { getRuntimeConfig } from '@/config/runtime'
import { useOptionalAppUpdate } from '@/features/app-update/app-update-context'
import { formatAppUpdateErrorSummary } from '@/features/app-update/app-update-error-copy'
import { CloudConnectionDialog } from '@/features/cloud-connection/CloudConnectionDialog'
import { isCloudConnectionUiAvailable } from '@/features/cloud-connection/cloudConnectionAvailability'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { User as UserProfile } from '@/types/api'
import { DesktopSettingsMenu } from './DesktopSettingsMenu'

export interface DesktopSidebarAccountSettingsOptions {
  autoOpenAddCloudDeviceDialog?: boolean
  settingsPage?: 'about' | 'connections'
}

interface DesktopSidebarAccountProps {
  user: UserProfile | null
  onOpenSettings: (options?: DesktopSidebarAccountSettingsOptions) => void
  onLogout: () => void
  containerRef?: RefObject<HTMLDivElement | null>
  trailingActions?: ReactNode
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

function SidebarUpdateDownloadProgress({ progress }: { progress: number }) {
  return (
    <span
      data-testid="sidebar-app-update-download-progress"
      role="progressbar"
      aria-label={`Update download ${progress}%`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
      className="flex h-4 w-4 items-center justify-center rounded-full"
      style={{
        background: `conic-gradient(rgb(var(--color-primary)) ${progress}%, rgb(var(--color-sidebar-hover)) 0)`,
      }}
    >
      <span className="h-2 w-2 rounded-full bg-[rgb(var(--color-sidebar))]" />
    </span>
  )
}

function SidebarAppUpdateButton({ onBeforeInstall }: { onBeforeInstall?: () => void }) {
  const { t } = useTranslation('common')
  const appUpdate = useOptionalAppUpdate()
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [errorTooltipPosition, setErrorTooltipPosition] = useState<{
    left: number
    top: number
  } | null>(null)
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

  const showErrorTooltip = () => {
    if (!errorSummary || !buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    setErrorTooltipPosition({
      left: Math.min(rect.right + 8, Math.max(8, window.innerWidth - 268)),
      top: Math.min(Math.max(8, rect.top + rect.height / 2), window.innerHeight - 8),
    })
  }

  if (!appUpdate || !availableUpdate) return null

  const title = formatSidebarTemplate(
    t('workbench.app_update_install', {
      defaultValue: '更新到 {{version}}',
      version: availableUpdate.version,
    }),
    { version: availableUpdate.version }
  )
  const downloadTitle = formatAppUpdateProgress(downloadProgress, t)

  return (
    <div
      className="group/update relative shrink-0"
      onPointerEnter={showErrorTooltip}
      onPointerLeave={() => setErrorTooltipPosition(null)}
      onFocus={showErrorTooltip}
      onBlur={() => setErrorTooltipPosition(null)}
    >
      <button
        ref={buttonRef}
        type="button"
        data-testid="sidebar-app-update-button"
        disabled={busy}
        onClick={() => {
          onBeforeInstall?.()
          void appUpdate.installUpdate()
        }}
        title={errorSummary ?? (status === 'downloading' ? downloadTitle : title)}
        aria-label={errorSummary ?? (status === 'downloading' ? downloadTitle : title)}
        className={cn(
          'group relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-60',
          errorSummary
            ? 'text-red-500 hover:bg-red-500/10'
            : 'text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]'
        )}
      >
        {status === 'downloading' && downloadPercent !== null ? (
          <SidebarUpdateDownloadProgress progress={downloadPercent} />
        ) : busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="sidebar-update-download-icon h-4 w-4" />
        )}
        {!busy && (
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary ring-2 ring-[rgb(var(--color-sidebar-hover))]" />
        )}
        {errorSummary && (
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-[rgb(var(--color-sidebar-hover))]" />
        )}
      </button>
      {errorSummary && errorTooltipPosition
        ? createPortal(
            <div
              data-testid="sidebar-app-update-error"
              style={errorTooltipPosition}
              className="fixed z-system-popover w-[260px] -translate-y-1/2 rounded-lg border border-red-500/20 bg-popover px-3 py-2 text-xs font-medium leading-5 text-red-500 shadow-[0_12px_28px_rgba(0,0,0,0.18)] [overflow-wrap:anywhere]"
            >
              {errorSummary}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

export function DesktopSidebarAccount({
  user,
  onOpenSettings,
  onLogout,
  containerRef: containerRefProp,
  trailingActions,
}: DesktopSidebarAccountProps) {
  const { t } = useTranslation('common')
  const cloud = useOptionalCloudConnection()
  const appUpdate = useOptionalAppUpdate()
  const usesCloudAccount =
    isCloudConnectionUiAvailable() && Boolean(getRuntimeConfig().wegentBackendUrl)
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
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false)
  const internalContainerRef = useRef<HTMLDivElement>(null)
  const containerRef = containerRefProp ?? internalContainerRef

  useEffect(() => {
    if (!menuOpen) return

    const handleOutsidePointer = (event: globalThis.MouseEvent | globalThis.PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }

    document.addEventListener('pointerdown', handleOutsidePointer)
    document.addEventListener('mousedown', handleOutsidePointer)
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer)
      document.removeEventListener('mousedown', handleOutsidePointer)
    }
  }, [containerRef, menuOpen])

  return (
    <>
      <div
        ref={containerRef}
        data-testid="desktop-sidebar-account"
        className="group/account relative shrink-0"
      >
        <div className="relative flex h-[60px] items-center rounded-[10px] transition-colors group-hover/account:bg-[rgb(var(--color-sidebar-hover))] group-focus-within/account:bg-[rgb(var(--color-sidebar-hover))]">
          <button
            type="button"
            data-testid="settings-button"
            onClick={() => setMenuOpen(open => !open)}
            className={cn(
              'flex h-[60px] min-w-0 flex-1 items-center gap-3 rounded-[10px] py-2 pl-1.5 text-left text-[rgb(var(--color-sidebar-text-primary))]',
              hasAvailableAppUpdate ? 'pr-[72px]' : 'pr-10'
            )}
            title={t('workbench.account_and_settings', '账户与设置')}
            aria-label={t('workbench.account_and_settings', '账户与设置')}
            aria-expanded={menuOpen}
          >
            <span
              data-testid="sidebar-account-avatar"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary"
            >
              <UserRound className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-semibold leading-[18px]">
                {account.label}
              </span>
              <span className="block truncate text-xs font-medium leading-4 text-[rgb(var(--color-sidebar-text-secondary))]">
                {account.detail}
              </span>
            </span>
          </button>
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
          {menuOpen && (
            <DesktopSettingsMenu
              user={user}
              showLogout={usesCloudAccount ? cloud.isConnected : undefined}
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
          )}
        </div>
      </div>

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
