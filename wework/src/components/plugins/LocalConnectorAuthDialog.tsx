import { ExternalLink, Loader2, QrCode, RefreshCw, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  LocalConnectorAuthResult,
  LocalConnectorAuthTarget,
} from '@/api/local/localConnectorAuth'
import { useLocalConnectorAuthSession } from '@/features/plugins/useLocalConnectorAuthSession'

interface LocalConnectorAuthDialogProps {
  open: boolean
  target: LocalConnectorAuthTarget
  title?: string
  description?: string
  onSuccess: (result: LocalConnectorAuthResult) => void
  onCancel: () => void
}

export function LocalConnectorAuthDialog({
  open,
  target,
  title,
  description,
  onSuccess,
  onCancel,
}: LocalConnectorAuthDialogProps) {
  const { t } = useTranslation()
  const {
    status,
    error,
    busy,
    usesBrowser,
    statusText,
    qrSrc,
    canRetry,
    retry,
    cancelActiveSession,
  } = useLocalConnectorAuthSession({
    enabled: open,
    target,
    t,
    onSuccess,
  })

  if (!open) return null

  const cancel = () => {
    cancelActiveSession()
    onCancel()
  }

  return (
    <div
      className="plugin-dialog-overlay fixed inset-0 z-modal flex items-center justify-center px-4"
      data-testid="local-connector-auth-dialog"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-connector-auth-title"
        className="plugin-dialog-surface w-full max-w-[480px] p-5"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="local-connector-auth-title" className="heading-subsection">
              {title ||
                (usesBrowser
                  ? t('workbench.plugins_local_browser_title', '在浏览器中授权')
                  : t('workbench.plugins_local_qr_title', '扫码登录'))}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {description ||
                (usesBrowser
                  ? t(
                      'workbench.plugins_local_browser_description',
                      'Wework 会准备所需的本机工具并打开浏览器。登录信息仅保存在本机凭据库。'
                    )
                  : t(
                      'workbench.plugins_local_qr_description',
                      '使用对应 App 扫描二维码完成授权。登录信息仅保存在本机凭据库。'
                    ))}
            </p>
          </div>
          <button
            type="button"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-text-muted hover:bg-surface md:h-8 md:w-8"
            onClick={cancel}
            aria-label={t('common.close', '关闭')}
            data-testid="local-connector-auth-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col items-center gap-3 rounded-xl border bg-muted/30 p-4">
          {usesBrowser ? (
            <div
              className="flex h-56 w-56 flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-background"
              data-testid="local-connector-auth-browser"
            >
              {status?.status === 'waiting_browser' ? (
                <ExternalLink className="h-8 w-8 text-muted-foreground" />
              ) : (
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              )}
              <span className="text-sm text-muted-foreground">
                {t('workbench.plugins_local_browser_device_only', '凭据仅保存在此设备')}
              </span>
            </div>
          ) : qrSrc ? (
            <img
              src={qrSrc}
              alt="Login QR code"
              className="h-56 w-56 rounded-lg bg-white p-2"
              data-testid="local-connector-auth-qr"
            />
          ) : (
            <div className="flex h-56 w-56 items-center justify-center rounded-lg border border-dashed bg-background">
              {busy ? (
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              ) : (
                <QrCode className="h-8 w-8 text-muted-foreground" />
              )}
            </div>
          )}
          <p className="text-center text-sm text-foreground">{statusText}</p>
          {error ? <p className="text-center text-sm text-destructive">{error}</p> : null}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className={cn(
              'inline-flex h-11 items-center gap-1 rounded-lg border px-3 text-sm md:h-9',
              'hover:bg-surface'
            )}
            onClick={cancel}
            data-testid="local-connector-auth-cancel"
          >
            {t('common.cancel', '取消')}
          </button>
          {canRetry ? (
            <button
              type="button"
              className="inline-flex h-11 items-center gap-1 rounded-lg bg-text-primary px-3 text-sm text-background hover:bg-text-primary/90 md:h-9"
              onClick={retry}
              data-testid="local-connector-auth-retry"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {usesBrowser
                ? t('workbench.plugins_local_browser_retry', '重新授权')
                : t('workbench.plugins_local_qr_refresh', '刷新二维码')}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  )
}
