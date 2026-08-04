import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2, QrCode, RefreshCw, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import {
  isLocalBrowserConnector,
  isLocalConnector,
  localConnectorAuthCancel,
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
  const { t } = useTranslation()
  const [status, setStatus] = useState<LocalConnectorAuthResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const onSuccessRef = useRef(onSuccess)
  const tRef = useRef(t)
  const sessionRef = useRef(0)
  const activeAuthSessionRef = useRef<string | null>(null)
  const cancelledAuthSessionsRef = useRef(new Set<string>())

  useEffect(() => {
    onSuccessRef.current = onSuccess
    tRef.current = t
  }, [onSuccess, t])

  const pluginKey = target.pluginKey
  const connectorSlug = target.connectorSlug
  const pluginRoot = target.pluginRoot ?? null
  const intervalMs = pollIntervalMs(target.localAuth)
  const supportsLocalAuth = isLocalConnector(target)
  const usesBrowser = isLocalBrowserConnector(target)
  const cancelAuthSession = useCallback(
    (authTarget: LocalConnectorAuthTarget, sessionId: string) => {
      if (cancelledAuthSessionsRef.current.has(sessionId)) return
      cancelledAuthSessionsRef.current.add(sessionId)
      void localConnectorAuthCancel(authTarget, sessionId).catch(() => undefined)
    },
    []
  )

  useEffect(() => {
    if (!open) return
    const session = ++sessionRef.current
    const isCurrent = () => sessionRef.current === session
    let startTimer: ReturnType<typeof setTimeout> | null = null
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let authSessionId: string | null = null
    const authTarget: LocalConnectorAuthTarget = {
      pluginKey,
      connectorSlug,
      ...(pluginRoot ? { pluginRoot } : {}),
    }

    const start = async () => {
      setBusy(true)
      setError(null)
      setStatus(null)
      try {
        if (!supportsLocalAuth) {
          throw new Error('Connector does not support local authentication')
        }
        const started = await localConnectorAuthStart(authTarget)
        if (!isCurrent()) {
          if (started.sessionId) {
            cancelAuthSession(authTarget, started.sessionId)
          }
          return
        }
        authSessionId = started.sessionId ?? null
        activeAuthSessionRef.current = authSessionId
        setError(null)
        setStatus(started)
        if (started.status === 'ok') {
          onSuccessRef.current(started)
          return
        }
        const tick = async () => {
          if (!isCurrent()) return
          try {
            const next = await localConnectorAuthPoll(authTarget, authSessionId)
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
            if (
              next.status === 'expired' ||
              next.status === 'error' ||
              next.status === 'cancelled'
            ) {
              setError(
                next.hint ||
                  (usesBrowser
                    ? tRef.current(
                        'workbench.plugins_local_browser_failed',
                        '浏览器授权未完成，请重新开始登录'
                      )
                    : tRef.current(
                        'workbench.plugins_local_qr_expired',
                        '二维码已失效，请重新开始登录'
                      ))
              )
              return
            }
            pollTimer = setTimeout(tick, intervalMs)
          } catch (pollError) {
            if (!isCurrent()) return
            setError(
              pollError instanceof Error
                ? pollError.message
                : tRef.current('workbench.plugins_local_auth_poll_failed', '检查登录状态失败')
            )
          }
        }
        pollTimer = setTimeout(tick, intervalMs)
      } catch (startError) {
        if (!isCurrent()) return
        setError(
          startError instanceof Error
            ? startError.message
            : usesBrowser
              ? tRef.current('workbench.plugins_local_browser_start_failed', '无法启动浏览器授权')
              : tRef.current('workbench.plugins_local_qr_start_failed', '无法生成登录二维码')
        )
      } finally {
        if (isCurrent()) setBusy(false)
      }
    }

    // React StrictMode replays effects during development. Deferring the side
    // effect lets the replay cleanup discard the first run before it creates a
    // second authorization session or opens another browser window.
    startTimer = setTimeout(() => void start(), 0)
    return () => {
      if (sessionRef.current === session) {
        sessionRef.current += 1
      }
      if (startTimer) clearTimeout(startTimer)
      if (pollTimer) clearTimeout(pollTimer)
      if (authSessionId) {
        cancelAuthSession(authTarget, authSessionId)
        if (activeAuthSessionRef.current === authSessionId) {
          activeAuthSessionRef.current = null
        }
      }
    }
  }, [
    open,
    refreshKey,
    pluginKey,
    connectorSlug,
    pluginRoot,
    intervalMs,
    supportsLocalAuth,
    usesBrowser,
    cancelAuthSession,
  ])

  if (!open) return null

  const qrSrc = status?.qrImage?.dataUrl || null
  const statusText = usesBrowser
    ? status?.status === 'verifying'
      ? t('workbench.plugins_local_browser_verifying', '正在验证本机登录状态…')
      : status?.status === 'waiting_browser'
        ? t('workbench.plugins_local_browser_waiting', '请在浏览器中确认授权，完成后会自动继续')
        : status?.hint || t('workbench.plugins_local_browser_preparing', '正在准备本机授权工具…')
    : status?.status === 'scanned'
      ? t('workbench.plugins_local_qr_scanned', '已扫码，请在手机上确认登录')
      : status?.status === 'waiting_scan' || status?.status === 'need_scan'
        ? t('workbench.plugins_local_qr_waiting', '请用新浪口袋扫描二维码')
        : status?.hint || t('workbench.plugins_local_qr_preparing', '正在准备登录二维码…')
  const canRetry =
    Boolean(error) ||
    status?.status === 'expired' ||
    status?.status === 'error' ||
    status?.status === 'cancelled'

  const cancel = () => {
    const sessionId = activeAuthSessionRef.current
    activeAuthSessionRef.current = null
    if (sessionId) {
      cancelAuthSession(
        {
          pluginKey,
          connectorSlug,
          ...(pluginRoot ? { pluginRoot } : {}),
        },
        sessionId
      )
    }
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
                      '使用新浪口袋扫描二维码完成授权。登录信息仅保存在本机凭据库。'
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
              onClick={() => setRefreshKey(value => value + 1)}
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
