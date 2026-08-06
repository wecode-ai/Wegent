import { useCallback, useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import {
  isLocalBrowserConnector,
  localConnectorAuthCancel,
  localConnectorAuthPoll,
  localConnectorAuthStart,
  pollIntervalMs,
  type LocalConnectorAuthResult,
  type LocalConnectorAuthTarget,
} from '@/api/local/localConnectorAuth'

export type LocalConnectorAuthTranslate = TFunction

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

function isBrowserAuthStatus(status: LocalConnectorAuthResult | null | undefined): boolean {
  return status?.status === 'waiting_browser' || status?.status === 'verifying'
}

export function localConnectorAuthStatusText(
  status: LocalConnectorAuthResult | null,
  options: {
    usesBrowser: boolean
    error: string | null
    t: LocalConnectorAuthTranslate
  }
): string {
  const { usesBrowser, error, t } = options
  if (error) return error
  if (usesBrowser) {
    if (status?.status === 'verifying') {
      return t('workbench.plugins_local_browser_verifying', '正在验证本机登录状态…')
    }
    if (status?.status === 'waiting_browser') {
      return t('workbench.plugins_local_browser_waiting', '请在浏览器中确认授权，完成后会自动继续')
    }
    return status?.hint || t('workbench.plugins_local_browser_preparing', '正在准备本机授权工具…')
  }
  if (status?.status === 'scanned') {
    return t('workbench.plugins_local_qr_scanned', '已扫码，请在手机上确认登录')
  }
  if (status?.status === 'waiting_scan' || status?.status === 'need_scan') {
    return (
      status?.hint || t('workbench.plugins_local_qr_waiting', '请使用对应 App 扫描二维码完成授权')
    )
  }
  return status?.hint || t('workbench.plugins_local_qr_preparing', '正在准备登录二维码…')
}

interface UseLocalConnectorAuthSessionOptions {
  enabled: boolean
  target: LocalConnectorAuthTarget
  t: LocalConnectorAuthTranslate
  onSuccess: (result: LocalConnectorAuthResult) => void
}

export function useLocalConnectorAuthSession({
  enabled,
  target,
  t,
  onSuccess,
}: UseLocalConnectorAuthSessionOptions) {
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
  // Prefer explicit localAuth from install dialogs; chat resume often omits it and
  // the executor resolves the manifest. Infer browser mode from live status too.
  const targetUsesBrowser = isLocalBrowserConnector(target)
  const usesBrowser = targetUsesBrowser || isBrowserAuthStatus(status)

  const cancelAuthSession = useCallback(
    (authTarget: LocalConnectorAuthTarget, sessionId: string) => {
      if (cancelledAuthSessionsRef.current.has(sessionId)) return
      cancelledAuthSessionsRef.current.add(sessionId)
      void localConnectorAuthCancel(authTarget, sessionId).catch(() => undefined)
    },
    []
  )

  useEffect(() => {
    if (!enabled) return
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
    // Do not put status-derived browser mode in effect deps; restarting would
    // cancel an in-flight browser session when waiting_browser arrives.
    const browserMode = targetUsesBrowser

    const start = async () => {
      setBusy(true)
      setError(null)
      setStatus(null)
      try {
        // Always start: chat resume targets may omit localAuth and rely on the
        // executor reading the installed plugin manifest by pluginKey/slug.
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
        const startedAsBrowser = browserMode || isBrowserAuthStatus(started)
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
                  (startedAsBrowser || isBrowserAuthStatus(next)
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
          startErrorMessage(
            startError,
            browserMode
              ? tRef.current('workbench.plugins_local_browser_start_failed', '无法启动浏览器授权')
              : tRef.current('workbench.plugins_local_qr_start_failed', '无法生成登录二维码')
          )
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
    enabled,
    refreshKey,
    pluginKey,
    connectorSlug,
    pluginRoot,
    intervalMs,
    targetUsesBrowser,
    cancelAuthSession,
  ])

  const retry = useCallback(() => {
    setRefreshKey(value => value + 1)
  }, [])

  const cancelActiveSession = useCallback(() => {
    const sessionId = activeAuthSessionRef.current
    activeAuthSessionRef.current = null
    if (!sessionId) return
    cancelAuthSession(
      {
        pluginKey,
        connectorSlug,
        ...(pluginRoot ? { pluginRoot } : {}),
      },
      sessionId
    )
  }, [cancelAuthSession, connectorSlug, pluginKey, pluginRoot])

  const canRetry =
    Boolean(error) ||
    status?.status === 'expired' ||
    status?.status === 'error' ||
    status?.status === 'cancelled'

  const statusText = localConnectorAuthStatusText(status, { usesBrowser, error, t })
  const qrSrc = status?.qrImage?.dataUrl || null

  return {
    status,
    error,
    busy,
    usesBrowser,
    statusText,
    qrSrc,
    canRetry,
    retry,
    cancelActiveSession,
  }
}
