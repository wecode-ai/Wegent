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

function startErrorMessage(startError: unknown, fallback: string): string {
  if (startError instanceof Error) return startError.message
  if (
    typeof startError === 'object' &&
    startError &&
    'message' in startError &&
    typeof (startError as { message: unknown }).message === 'string'
  ) {
    return (startError as { message: string }).message
  }
  return fallback
}

export function ConnectorAuthCard({ target, title, onSuccess, onCancel }: ConnectorAuthCardProps) {
  const { t } = useTranslation('chat')
  const [status, setStatus] = useState<LocalConnectorAuthResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const onSuccessRef = useRef(onSuccess)
  const tRef = useRef(t)
  const sessionRef = useRef(0)

  useEffect(() => {
    onSuccessRef.current = onSuccess
    tRef.current = t
  }, [onSuccess, t])

  const pluginKey = target.pluginKey
  const connectorSlug = target.connectorSlug
  const pluginRoot = target.pluginRoot ?? null
  const intervalMs = pollIntervalMs(target.localAuth)

  useEffect(() => {
    const session = ++sessionRef.current
    const isCurrent = () => sessionRef.current === session
    let timer: ReturnType<typeof setTimeout> | null = null
    const authTarget: LocalConnectorAuthTarget = {
      pluginKey,
      connectorSlug,
      ...(pluginRoot ? { pluginRoot } : {}),
    }

    const run = async () => {
      setError(null)
      setStatus(null)
      try {
        const started = await localConnectorAuthStart(authTarget)
        if (!isCurrent()) return
        setError(null)
        setStatus(started)
        if (started.status === 'ok') {
          onSuccessRef.current(started)
          return
        }
        const tick = async () => {
          if (!isCurrent()) return
          try {
            const next = await localConnectorAuthPoll(authTarget)
            if (!isCurrent()) return
            setStatus(previous => ({
              ...next,
              qrImage: next.qrImage ?? previous?.qrImage ?? null,
              qrPath: next.qrPath ?? previous?.qrPath ?? null,
            }))
            if (next.status === 'ok') {
              onSuccessRef.current(next)
              return
            }
            if (next.status === 'expired' || next.status === 'error') {
              setError(next.hint || tRef.current('connector_auth_expired', '二维码已失效，请重试'))
              return
            }
            timer = setTimeout(tick, intervalMs)
          } catch (pollError) {
            if (!isCurrent()) return
            setError(
              pollError instanceof Error
                ? pollError.message
                : tRef.current('connector_auth_poll_failed', '检查登录状态失败')
            )
          }
        }
        timer = setTimeout(tick, intervalMs)
      } catch (startError) {
        if (!isCurrent()) return
        setError(
          startErrorMessage(
            startError,
            tRef.current('connector_auth_start_failed', '无法生成登录二维码')
          )
        )
      }
    }

    void run()
    return () => {
      if (sessionRef.current === session) {
        sessionRef.current += 1
      }
      if (timer) clearTimeout(timer)
    }
  }, [pluginKey, connectorSlug, pluginRoot, intervalMs, retryNonce])

  const qrSrc = status?.qrImage?.dataUrl || null
  const statusText = error
    ? error
    : status?.status === 'scanned'
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
        {qrSrc && !error ? (
          <img
            src={qrSrc}
            alt="Login QR code"
            className="h-52 w-52 rounded-lg bg-white p-2"
            data-testid="connector-auth-qr"
          />
        ) : error ? (
          <div className="flex h-52 w-52 flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-background p-3 text-center">
            <QrCode className="h-7 w-7 text-muted-foreground" />
            <p className="text-xs text-destructive" data-testid="connector-auth-error">
              {error}
            </p>
          </div>
        ) : (
          <div className="flex h-52 w-52 items-center justify-center rounded-lg border border-dashed bg-background">
            <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
          </div>
        )}
        <div className="flex items-center gap-2 text-sm">
          <QrCode className="h-4 w-4 text-muted-foreground" />
          <span>{statusText}</span>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        {error ? (
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            data-testid="connector-auth-retry"
            onClick={() => setRetryNonce(value => value + 1)}
          >
            {t('workbench.retry', '重试')}
          </button>
        ) : null}
        {onCancel ? (
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            onClick={onCancel}
          >
            {t('common.cancel', '取消')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
