import { useEffect, useRef, useState } from 'react'
import { Loader2, QrCode, RefreshCw, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import {
  isLocalQrConnector,
  localConnectorAuthPoll,
  localConnectorAuthStart,
  pollIntervalMs,
  type LocalConnectorAuthResult,
  type LocalConnectorAuthTarget,
} from '@/api/local/localConnectorAuth'

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
  const { t } = useTranslation('workbench')
  const [status, setStatus] = useState<LocalConnectorAuthResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const cancelledRef = useRef(false)
  const successRef = useRef(false)

  useEffect(() => {
    if (!open) return
    cancelledRef.current = false
    successRef.current = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const start = async () => {
      setBusy(true)
      setError(null)
      setStatus(null)
      try {
        if (!isLocalQrConnector(target)) {
          throw new Error('Connector does not support local QR authentication')
        }
        const started = await localConnectorAuthStart(target)
        if (cancelledRef.current) return
        setStatus(started)
        if (started.status === 'ok') {
          successRef.current = true
          onSuccess(started)
          return
        }
        const tick = async () => {
          if (cancelledRef.current || successRef.current) return
          try {
            const next = await localConnectorAuthPoll(target)
            if (cancelledRef.current) return
            setStatus(previous => ({
              ...next,
              qrImage: next.qrImage ?? previous?.qrImage ?? null,
              qrPath: next.qrPath ?? previous?.qrPath ?? null,
            }))
            if (next.status === 'ok') {
              successRef.current = true
              onSuccess(next)
              return
            }
            if (next.status === 'expired' || next.status === 'error') {
              setError(next.hint || t('plugins_local_qr_expired', '二维码已失效，请重新开始登录'))
              return
            }
            timer = setTimeout(tick, pollIntervalMs(target.localAuth))
          } catch (pollError) {
            if (cancelledRef.current) return
            setError(
              pollError instanceof Error
                ? pollError.message
                : t('plugins_local_qr_poll_failed', '检查登录状态失败')
            )
          }
        }
        timer = setTimeout(tick, pollIntervalMs(target.localAuth))
      } catch (startError) {
        if (cancelledRef.current) return
        setError(
          startError instanceof Error
            ? startError.message
            : t('plugins_local_qr_start_failed', '无法生成登录二维码')
        )
      } finally {
        if (!cancelledRef.current) setBusy(false)
      }
    }

    void start()
    return () => {
      cancelledRef.current = true
      if (timer) clearTimeout(timer)
    }
  }, [open, onSuccess, refreshKey, t, target])

  if (!open) return null

  const qrSrc = status?.qrImage?.dataUrl || null
  const statusText =
    status?.status === 'scanned'
      ? t('plugins_local_qr_scanned', '已扫码，请在手机上确认登录')
      : status?.status === 'waiting_scan' || status?.status === 'need_scan'
        ? t('plugins_local_qr_waiting', '请用新浪口袋扫描二维码')
        : status?.hint || t('plugins_local_qr_preparing', '正在准备登录二维码…')

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4"
      data-testid="local-connector-auth-dialog"
    >
      <div className="w-full max-w-md rounded-2xl bg-background p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">
              {title || t('plugins_local_qr_title', '扫码登录')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {description ||
                t(
                  'plugins_local_qr_description',
                  '使用新浪口袋扫描二维码完成授权。登录信息仅保存在本机凭据库。'
                )}
            </p>
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            onClick={onCancel}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col items-center gap-3 rounded-xl border bg-muted/30 p-4">
          {qrSrc ? (
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
              'inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm',
              'hover:bg-muted'
            )}
            onClick={onCancel}
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            onClick={() => setRefreshKey(value => value + 1)}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('plugins_local_qr_refresh', '刷新二维码')}
          </button>
        </div>
      </div>
    </div>
  )
}
