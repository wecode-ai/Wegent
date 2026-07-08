import { AlertCircle, Cloud, Loader2, LogOut, Plus, Server, Settings, X } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
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
}: CloudConnectionDialogProps) {
  const { t } = useTranslation('common')
  const cloud = useOptionalCloudConnection()
  const [backendUrl, setBackendUrl] = useState(cloud.backendUrl ?? '')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEscapeKey(onClose)

  if (!open) return null

  const isConnected = cloud.isConnected
  const host = displayHost(cloud.backendUrl)

  async function handleAuthorizationSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      normalizeCloudBackendUrl(backendUrl)
      await cloud.connectWithAuthorization(backendUrl, openCloudAuthorizationWindow)
      onClose()
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
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
      onClick={event => {
        if (!submitting && event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-testid="cloud-connection-dialog"
        className="w-full max-w-[460px] rounded-lg border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Cloud className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-text-primary">
              {t('workbench.cloud_connection_title', '连接云端')}
            </h2>
            <p className="mt-1 text-sm leading-5 text-text-secondary">
              {t(
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
            className="-mr-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary disabled:opacity-50"
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
                className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-muted"
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
                  className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-muted"
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
                  className="inline-flex h-10 items-center gap-2 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:bg-text-primary/90"
                >
                  <Settings className="h-4 w-4" />
                  {t('workbench.cloud_connection_settings', '云端设置')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-5 space-y-5">
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
              <p className="mt-1.5 text-xs text-text-muted">
                {t(
                  'workbench.cloud_connection_backend_hint',
                  '可输入 backend 根地址或 /api 地址，系统会自动归一化连接配置。'
                )}
              </p>
            </div>

            {cloud.status === 'connecting' && (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-secondary">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('workbench.cloud_connection_connecting', '正在连接云端')}
              </div>
            )}

            {(error || cloud.error) && (
              <div
                data-testid="cloud-connection-error"
                className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error || cloud.error}</span>
              </div>
            )}

            <form data-testid="cloud-authorization-form" onSubmit={handleAuthorizationSubmit}>
              <button
                type="submit"
                data-testid="cloud-authorization-submit-button"
                disabled={submitting}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('workbench.cloud_connection_waiting_authorization', '等待云端授权')}
                  </>
                ) : (
                  <>
                    <Cloud className="h-4 w-4" />
                    {t('workbench.cloud_connection_authorize', '连接')}
                  </>
                )}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
