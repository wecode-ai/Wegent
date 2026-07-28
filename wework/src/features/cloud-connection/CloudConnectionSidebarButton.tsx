import { AlertCircle, Cloud, Loader2, Settings } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { canUseForProjectCreation, isCloudDevice, isRemoteDevice } from '@/lib/device-capabilities'
import { cn } from '@/lib/utils'
import type { DeviceInfo } from '@/types/api'
import type { CloudWorkCheckStatus, CloudWorkStatus } from '@/types/workbench'
import { useTranslation } from '@/hooks/useTranslation'
import { useOptionalCloudConnection } from './useCloudConnection'
import { CloudConnectionDialog } from './CloudConnectionDialog'

interface CloudConnectionSidebarButtonProps {
  devices: DeviceInfo[]
  cloudWorkStatus?: CloudWorkStatus
  onOpenSettings: () => void
  onSelectCloudDevice: (deviceId: string) => void
  onAddDevice: () => void
}

const POPOVER_WIDTH = 288
const POPOVER_GAP = 4
const VIEWPORT_PADDING = 8

function hostLabel(value?: string | null): string {
  if (!value) return ''
  try {
    return new URL(value).host
  } catch {
    return value
  }
}

export function CloudConnectionSidebarButton({
  devices,
  cloudWorkStatus,
  onOpenSettings,
  onSelectCloudDevice,
  onAddDevice,
}: CloudConnectionSidebarButtonProps) {
  const { t } = useTranslation('common')
  const cloud = useOptionalCloudConnection()
  const [open, setOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [popoverPosition, setPopoverPosition] = useState({ left: 0, top: 0 })
  const cloudWorkDevices = useMemo(
    () => devices.filter(device => isCloudDevice(device) || isRemoteDevice(device)),
    [devices]
  )
  const onlineCloudDeviceCount = useMemo(
    () => cloudWorkDevices.filter(device => device.status === 'online').length,
    [cloudWorkDevices]
  )
  const preferredCloudDevice = useMemo(() => {
    return cloudWorkDevices.filter(canUseForProjectCreation).sort((left, right) => {
      const leftBusy = left.status === 'busy' ? 1 : 0
      const rightBusy = right.status === 'busy' ? 1 : 0
      if (leftBusy !== rightBusy) return leftBusy - rightBusy
      return (left.name || left.device_id).localeCompare(right.name || right.device_id)
    })[0]
  }, [cloudWorkDevices])
  const connected = cloud.isConnected
  const needsAttention = cloud.status === 'expired' || cloud.status === 'error'
  const cloudWorkUnavailable =
    connected && !needsAttention && cloudWorkStatus?.availability === 'unavailable'
  const cloudWorkEmpty = connected && !needsAttention && cloudWorkStatus?.availability === 'empty'
  const cloudWorkSyncing =
    connected &&
    !needsAttention &&
    !cloudWorkUnavailable &&
    !cloudWorkEmpty &&
    cloudWorkStatus?.availability === 'syncing'
  const cloudWorkAvailable =
    connected && !needsAttention && cloudWorkStatus?.availability === 'available'
  const hasErrorDetail = connected && (needsAttention || cloudWorkUnavailable)
  const statusLabel =
    needsAttention || cloudWorkUnavailable
      ? t('workbench.cloud_work_unavailable', '不可用')
      : cloudWorkSyncing
        ? t('workbench.cloud_work_syncing', '同步中')
        : cloudWorkEmpty
          ? t('workbench.cloud_work_empty', '无设备')
          : cloudWorkAvailable
            ? t('workbench.cloud_work_available', '可用')
            : null
  const label = connected
    ? t('workbench.cloud_work_entry', '云端工作')
    : needsAttention
      ? t('workbench.cloud_connection_attention', '云端连接已失效')
      : t('workbench.cloud_connection_sidebar_disconnected', '连接云端')
  const title = connected
    ? t('workbench.cloud_connection_sidebar_connected', {
        defaultValue: '{{host}} · {{user}} · 云端工作{{status}} · {{count}} 台在线云设备',
        host: hostLabel(cloud.backendUrl) || '-',
        user: cloud.user?.user_name ?? '-',
        status: statusLabel ?? '-',
        count: onlineCloudDeviceCount,
      })
    : label
  const statusTitle = cloudWorkStatus?.error ? `${title}\n${cloudWorkStatus.error}` : title
  const errorDetail = needsAttention
    ? cloud.error ||
      t('workbench.cloud_connection_relogin_required', '云端登录已过期，请重新登录。')
    : cloudWorkUnavailable
      ? cloudWorkStatus?.error || t('workbench.cloud_work_unavailable_detail', '云端工作暂不可用。')
      : null
  const checkLabels: Record<keyof CloudWorkStatus['checks'], string> = {
    teams: t('workbench.cloud_work_check_teams', '云端智能体'),
    devices: t('workbench.cloud_work_check_devices', '云端设备'),
    runtimeWork: t('workbench.cloud_work_check_runtime_work', '云端任务列表'),
  }
  const checkStatusLabels: Record<CloudWorkCheckStatus, string> = {
    idle: t('workbench.cloud_work_check_idle', '未检查'),
    syncing: t('workbench.cloud_work_syncing', '同步中'),
    available: t('workbench.cloud_work_available', '可用'),
    empty: t('workbench.cloud_work_empty', '无设备'),
    unavailable: t('workbench.cloud_work_unavailable', '不可用'),
  }

  // Reset the details popover when the error clears. Adjusting state during
  // render (instead of in an effect) avoids the cascading-render warning and
  // keeps the popover from reappearing if the same error returns later.
  const [prevErrorDetail, setPrevErrorDetail] = useState(errorDetail)
  if (errorDetail !== prevErrorDetail) {
    setPrevErrorDetail(errorDetail)
    if (!errorDetail) setDetailsOpen(false)
  }

  useLayoutEffect(() => {
    if (!detailsOpen) return

    const updatePosition = () => {
      const triggerRect = rootRef.current?.getBoundingClientRect()
      if (!triggerRect) return
      const popoverHeight = popoverRef.current?.getBoundingClientRect().height ?? 0
      const maxLeft = Math.max(
        VIEWPORT_PADDING,
        window.innerWidth - POPOVER_WIDTH - VIEWPORT_PADDING
      )
      const left = Math.min(Math.max(triggerRect.left, VIEWPORT_PADDING), maxLeft)
      const preferredTop = triggerRect.bottom + POPOVER_GAP
      const top =
        popoverHeight > 0 && preferredTop + popoverHeight > window.innerHeight - VIEWPORT_PADDING
          ? Math.max(VIEWPORT_PADDING, triggerRect.top - POPOVER_GAP - popoverHeight)
          : preferredTop
      setPopoverPosition({ left, top })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [detailsOpen, errorDetail])

  useEffect(() => {
    if (!detailsOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setDetailsOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDetailsOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [detailsOpen])

  return (
    <>
      <div
        ref={rootRef}
        className="group/cloud relative flex h-[30px] items-center rounded-[10px] hover:bg-[rgb(var(--color-sidebar-hover))]"
      >
        <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center">
          {cloudWorkSyncing ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : hasErrorDetail ? (
            <button
              type="button"
              data-testid="sidebar-cloud-error-button"
              onClick={event => {
                event.stopPropagation()
                setDetailsOpen(open => !open)
              }}
              title={t('workbench.cloud_work_error_details', '查看错误详情')}
              aria-label={t('workbench.cloud_work_error_details', '查看错误详情')}
              aria-expanded={detailsOpen}
              aria-controls={detailsOpen ? 'sidebar-cloud-error-popover' : undefined}
              className="flex h-6 w-6 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10"
            >
              <AlertCircle className="h-4 w-4" />
            </button>
          ) : (
            <Cloud
              className={cn(
                'h-4 w-4',
                connected && !cloudWorkEmpty
                  ? 'text-primary'
                  : 'text-[rgb(var(--color-sidebar-text-primary))]'
              )}
            />
          )}
        </div>
        <button
          type="button"
          data-testid="sidebar-cloud-connection-button"
          onClick={() => {
            if (connected) {
              if (cloudWorkAvailable) {
                onOpenSettings()
                return
              }
              if (errorDetail) {
                setDetailsOpen(true)
                return
              }
              if (preferredCloudDevice) {
                onSelectCloudDevice(preferredCloudDevice.device_id)
              } else {
                onAddDevice()
              }
              return
            }
            setOpen(true)
          }}
          title={statusTitle}
          className={cn(
            'flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-[10px] py-0 pl-0 pr-2 text-left text-base font-normal leading-5 text-[rgb(var(--color-sidebar-text-primary))]',
            (needsAttention || cloudWorkUnavailable) && 'text-red-500'
          )}
        >
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {connected && statusLabel && (
            <span
              data-testid="sidebar-cloud-status-label"
              className={cn(
                'ml-auto shrink-0 rounded-full px-1.5 text-xs font-semibold leading-5 group-hover/cloud:invisible group-focus-within/cloud:invisible',
                cloudWorkAvailable && 'bg-primary/10 text-primary',
                cloudWorkSyncing && 'bg-primary/10 text-primary',
                cloudWorkEmpty &&
                  'bg-[rgb(var(--color-bg-surface))] text-[rgb(var(--color-sidebar-text-secondary))]',
                (needsAttention || cloudWorkUnavailable) && 'bg-red-500/10 text-red-500'
              )}
            >
              {statusLabel}
            </span>
          )}
        </button>
        {connected && (
          <button
            type="button"
            data-testid="sidebar-cloud-management-button"
            onClick={event => {
              event.stopPropagation()
              onOpenSettings()
            }}
            title={t('workbench.cloud_connection_manage', '管理云端连接')}
            aria-label={t('workbench.cloud_connection_manage', '管理云端连接')}
            className={cn(
              'pointer-events-none absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] opacity-0 transition-opacity hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] focus:pointer-events-auto focus:opacity-100 group-hover/cloud:pointer-events-auto group-hover/cloud:opacity-100 group-focus-within/cloud:pointer-events-auto group-focus-within/cloud:opacity-100',
              needsAttention && 'text-red-500'
            )}
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {detailsOpen &&
        errorDetail &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            id="sidebar-cloud-error-popover"
            data-testid="sidebar-cloud-error-popover"
            role="status"
            style={{ left: popoverPosition.left, top: popoverPosition.top }}
            className="fixed z-system-popover max-h-[calc(100vh-16px)] w-72 overflow-y-auto rounded-xl border border-red-500/20 bg-popover p-3 text-xs text-text-primary shadow-lg ring-1 ring-black/5"
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-text-primary">
                  {t('workbench.cloud_work_error_title', '云端工作不可用')}
                </div>
                <div className="mt-1 leading-5 text-text-secondary">{errorDetail}</div>
              </div>
            </div>
            {cloudWorkStatus && (
              <div className="mt-3 grid gap-1.5 border-t border-border pt-2">
                {(Object.keys(checkLabels) as Array<keyof CloudWorkStatus['checks']>).map(key => (
                  <div key={key} className="flex items-center justify-between gap-3">
                    <span className="text-text-secondary">{checkLabels[key]}</span>
                    <span
                      className={cn(
                        'font-medium',
                        cloudWorkStatus.checks[key] === 'unavailable'
                          ? 'text-red-500'
                          : 'text-text-primary'
                      )}
                    >
                      {checkStatusLabels[cloudWorkStatus.checks[key]]}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>,
          document.body
        )}
      {open && (
        <CloudConnectionDialog
          open
          onlineCloudDeviceCount={onlineCloudDeviceCount}
          onClose={() => setOpen(false)}
          onOpenSettings={onOpenSettings}
          onAddDevice={onAddDevice}
        />
      )}
    </>
  )
}
