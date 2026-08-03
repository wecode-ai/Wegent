import { useEffect, useRef, useState } from 'react'
import { Loader2, QrCode } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  localConnectorAuthPoll,
  localConnectorAuthStart,
  pollIntervalMs,
  type LocalConnectorAuthResult,
  type LocalConnectorAuthTarget,
} from '@/api/local/localConnectorAuth'

interface ConnectorAuthCardProps {
  target: LocalConnectorAuthTarget
  title?: string
  onSuccess: (result: LocalConnectorAuthResult) => void
  onCancel?: () => void
}

export function ConnectorAuthCard({ target, title, onSuccess, onCancel }: ConnectorAuthCardProps) {
  const { t } = useTranslation('chat')
  const [status, setStatus] = useState<LocalConnectorAuthResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cancelledRef = useRef(false)
  const successRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    successRef.current = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const run = async () => {
      try {
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
              setError(next.hint || t('connector_auth_expired', '二维码已失效，请重试'))
              return
            }
            timer = setTimeout(tick, pollIntervalMs(target.localAuth))
          } catch (pollError) {
            if (cancelledRef.current) return
            setError(
              pollError instanceof Error
                ? pollError.message
                : t('connector_auth_poll_failed', '检查登录状态失败')
            )
          }
        }
        timer = setTimeout(tick, pollIntervalMs(target.localAuth))
      } catch (startError) {
        if (cancelledRef.current) return
        setError(
          startError instanceof Error
            ? startError.message
            : t('connector_auth_start_failed', '无法生成登录二维码')
        )
      }
    }

    void run()
    return () => {
      cancelledRef.current = true
      if (timer) clearTimeout(timer)
    }
  }, [onSuccess, t, target])

  const qrSrc = status?.qrImage?.dataUrl || null
  const statusText =
    status?.status === 'scanned'
      ? t('connector_auth_scanned', '已扫码，请在手机上确认登录')
      : status?.status === 'waiting_scan' || status?.status === 'need_scan'
        ? t('connector_auth_waiting', '请用新浪口袋扫描二维码')
        : status?.hint || t('connector_auth_preparing', '正在准备登录二维码…')

  return (
    <div
      className="mb-3 max-w-md rounded-2xl border bg-background p-4 shadow-sm"
      data-testid="connector-auth-card"
    >
      <div className="mb-3">
        <h3 className="text-sm font-semibold">
          {title || t('connector_auth_title', '需要扫码登录')}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            'connector_auth_description',
            '登录完成后会自动继续当前任务，无需在对话里输入“继续”。'
          )}
        </p>
      </div>
      <div className="flex flex-col items-center gap-3 rounded-xl bg-muted/30 p-4">
        {qrSrc ? (
          <img
            src={qrSrc}
            alt="Login QR code"
            className="h-52 w-52 rounded-lg bg-white p-2"
            data-testid="connector-auth-qr"
          />
        ) : (
          <div className="flex h-52 w-52 items-center justify-center rounded-lg border border-dashed bg-background">
            <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
          </div>
        )}
        <div className="flex items-center gap-2 text-sm">
          <QrCode className="h-4 w-4 text-muted-foreground" />
          <span>{statusText}</span>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
      {onCancel ? (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            onClick={onCancel}
          >
            {t('common.cancel', '取消')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
