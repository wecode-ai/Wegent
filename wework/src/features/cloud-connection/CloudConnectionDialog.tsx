import {
  AlertCircle,
  ChevronRight,
  Cloud,
  Loader2,
  LogOut,
  Plus,
  Server,
  Settings,
  X,
} from 'lucide-react'
import { useCallback, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { getRuntimeConfig } from '@/config/runtime'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { setEmbeddedBrowserOcclusion } from '@/lib/embedded-browser'
import { useTranslation } from '@/hooks/useTranslation'
import { openCloudAuthorizationWindow } from '@/lib/cloud-authorization-window'
import { normalizeCloudBackendUrl } from './cloudConnectionStorage'
import { useOptionalCloudConnection } from './useCloudConnection'

interface CloudConnectionDialogProps {
  open: boolean
  onlineCloudDeviceCount: number
  onClose: () => void
  onOpenSettings: () => void
  onAddDevice?: () => void
  intent?: 'independent-issue'
  onConnected?: () => void
}

function displayHost(value?: string | null): string {
  if (!value) return ''
  try {
    return new URL(value).host
  } catch {
    return value
  }
}

export function CloudConnectionDialog({
  open,
  onlineCloudDeviceCount,
  onClose,
  onOpenSettings,
  onAddDevice,
  intent,
  onConnected,
}: CloudConnectionDialogProps) {
  const { t } = useTranslation('common')
  const cloud = useOptionalCloudConnection()
  const bindOverlay = useCallback((element: HTMLDivElement | null) => {
    if (!element) return
    setEmbeddedBrowserOcclusion('cloud-connection-dialog', true)
    return () => setEmbeddedBrowserOcclusion('cloud-connection-dialog', false)
  }, [])
  const [backendUrl, setBackendUrl] = useState(
    () => cloud.backendUrl || getRuntimeConfig().wegentBackendUrl
  )
  const [socketBaseUrl, setSocketBaseUrl] = useState(() => cloud.socketBaseUrlOverride || '')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useDialogKeyboard<HTMLDivElement>(
    onClose,
    open,
    '[data-testid="cloud-backend-url-input"]'
  )

  if (!open) return null

  const isConnected = cloud.isConnected
  const canDisconnect = cloud.status === 'error' || cloud.status === 'expired'
  const host = displayHost(cloud.backendUrl)
  const cloudError =
    cloud.error === 'Cloud login has expired'
      ? t('workbench.cloud_connection_relogin_required', '云端登录已过期，请重新登录。')
      : cloud.error

  async function handleAuthorizationSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      normalizeCloudBackendUrl(backendUrl, socketBaseUrl)
      await cloud.connectWithAuthorization(backendUrl, openCloudAuthorizationWindow, socketBaseUrl)
      if (onConnected) onConnected()
      else onClose()
    } catch (connectError) {
      setError(
        connectError instanceof Error
          ? connectError.message
          : t('workbench.cloud_connection_login_failed', '登录失败')
      )
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div
      ref={bindOverlay}
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
      onClick={event => {
        if (!submitting && event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        ref={dialogRef}
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-testid="cloud-connection-dialog"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-[460px] overflow-y-auto rounded-lg border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Cloud className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold text-text-primary">
              {t(
                intent === 'independent-issue'
                  ? 'personalHome.connectForIssueTitle'
                  : 'workbench.cloud_connection_title'
              )}
            </h2>
            <p id={descriptionId} className="mt-1 text-sm leading-5 text-text-secondary">
              {intent === 'independent-issue'
                ? t('personalHome.connectForIssueHint')
                : t(
                    'workbench.cloud_connection_description',
                    '授权后会加入服务端模型、云设备和云端 Codex 认证同步。'
                  )}
            </p>
          </div>
          <button
            type="button"
            data-testid="cloud-connection-close-button"
            onClick={onClose}
            disabled={submitting}
            className="-mr-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary disabled:opacity-50 max-md:h-11 max-md:w-11"
            aria-label={t('workbench.close_dialog', '关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {isConnected ? (
          <div className="mt-5 space-y-4">
            <div className="rounded-lg border border-border bg-background p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <Server className="h-4 w-4 text-primary" />
                <span>{host}</span>
              </div>
              <div className="mt-3 grid gap-2 text-xs text-text-secondary">
                <div>
                  {t('workbench.cloud_connection_user', '云端用户')}:{' '}
                  <span className="font-medium text-text-primary">{cloud.user?.user_name}</span>
                </div>
                <div>
                  {t('workbench.cloud_connection_online_devices', '在线云设备')}:{' '}
                  <span className="font-medium text-text-primary">{onlineCloudDeviceCount}</span>
                </div>
              </div>
            </div>
            <div className="flex justify-between gap-2">
              <button
                type="button"
                data-testid="cloud-add-device-button"
                onClick={() => {
                  onClose()
                  onAddDevice?.()
                }}
                className="inline-flex h-10 max-md:min-h-11 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-muted"
              >
                <Plus className="h-4 w-4" />
                {t('workbench.cloud_connection_add_device', '添加设备')}
              </button>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  data-testid="cloud-disconnect-button"
                  onClick={() => {
                    cloud.disconnect()
                    onClose()
                  }}
                  className="inline-flex h-10 max-md:min-h-11 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-muted"
                >
                  <LogOut className="h-4 w-4" />
                  {t('workbench.cloud_connection_disconnect', '断开')}
                </button>
                <button
                  type="button"
                  data-testid="cloud-settings-button"
                  onClick={() => {
                    onClose()
                    onOpenSettings()
                  }}
                  className="inline-flex h-10 max-md:min-h-11 items-center gap-2 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:bg-text-primary/90"
                >
                  <Settings className="h-4 w-4" />
                  {t('workbench.cloud_connection_settings', '云端设置')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <form
            data-testid="cloud-authorization-form"
            onSubmit={handleAuthorizationSubmit}
            className="mt-5 space-y-5"
          >
            <div>
              <label
                htmlFor="cloud-backend-url-input"
                className="text-sm font-medium text-text-secondary"
              >
                {t('workbench.cloud_connection_backend_url', 'Wegent Backend 地址')}
              </label>
              <input
                id="cloud-backend-url-input"
                data-testid="cloud-backend-url-input"
                value={backendUrl}
                onChange={event => setBackendUrl(event.target.value)}
                placeholder="http://localhost:8000"
                className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-text-secondary"
                disabled={submitting}
              />
              <p className="mt-1.5 text-xs text-text-secondary">
                {t(
                  'workbench.cloud_connection_backend_hint',
                  '可输入 backend 根地址或 /api 地址，系统会自动归一化连接配置。'
                )}
              </p>
            </div>

            <details className="group rounded-lg border border-border bg-background">
              <summary
                data-testid="cloud-connection-advanced-toggle"
                className="flex h-10 max-md:min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium text-text-secondary hover:text-text-primary"
              >
                <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
                {t('workbench.cloud_connection_advanced', '高级配置')}
              </summary>
              <div className="border-t border-border px-3 py-3">
                <label
                  htmlFor="cloud-socket-url-input"
                  className="text-sm font-medium text-text-secondary"
                >
                  {t('workbench.cloud_connection_socket_url', 'WebSocket 地址（可选）')}
                </label>
                <input
                  id="cloud-socket-url-input"
                  data-testid="cloud-socket-url-input"
                  value={socketBaseUrl}
                  onChange={event => setSocketBaseUrl(event.target.value)}
                  placeholder="wss://wss-wegent.example.com"
                  className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-text-secondary"
                  disabled={submitting}
                />
                <p className="mt-1.5 text-xs text-text-secondary">
                  {t(
                    'workbench.cloud_connection_socket_hint',
                    '留空时使用应用配置，未配置则自动使用 Backend 域名。'
                  )}
                </p>
              </div>
            </details>

            {['restoring', 'connecting'].includes(cloud.status) && (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-secondary">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('workbench.cloud_connection_connecting', '正在连接云端')}
              </div>
            )}

            {(error || cloudError) && (
              <div
                data-testid="cloud-connection-error"
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-text-primary"
              >
                <AlertCircle
                  className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{t('workbench.cloud_connection_login_failed')}</p>
                  <p className="mt-1 text-text-secondary">
                    {t(
                      !error && cloud.status === 'expired'
                        ? 'workbench.cloud_connection_relogin_required'
                        : 'workbench.cloud_connection_recovery'
                    )}
                  </p>
                  <details data-testid="cloud-connection-error-details" className="mt-1">
                    <summary
                      data-testid="cloud-connection-error-details-toggle"
                      className="inline-flex min-h-11 cursor-pointer items-center text-text-primary md:min-h-7"
                    >
                      {t('workbench.cloud_connection_error_details')}
                    </summary>
                    <p className="break-words text-xs text-text-secondary">{error || cloudError}</p>
                  </details>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              {canDisconnect && (
                <button
                  type="button"
                  data-testid="cloud-disconnect-button"
                  disabled={submitting}
                  onClick={() => {
                    cloud.disconnect()
                    onClose()
                  }}
                  className="inline-flex h-10 max-md:min-h-11 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <LogOut className="h-4 w-4" />
                  {t('workbench.cloud_connection_disconnect', '断开连接')}
                </button>
              )}
              <div className={canDisconnect ? 'flex-1' : 'w-full'}>
                <button
                  type="submit"
                  data-testid="cloud-authorization-submit-button"
                  disabled={submitting}
                  className="inline-flex h-10 max-md:min-h-11 w-full items-center justify-center gap-2 rounded-md bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t(
                        'workbench.cloud_connection_waiting_authorization',
                        '请在弹出窗口中完成 Wework 授权'
                      )}
                    </>
                  ) : (
                    <>
                      <Cloud className="h-4 w-4" />
                      {t('workbench.cloud_connection_authorize', '连接')}
                    </>
                  )}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body
  )
}
