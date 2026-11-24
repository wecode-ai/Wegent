import { useMemo, useSyncExternalStore } from 'react'
import { subscribeIdleResource } from '@wegent/chat-core/async-resource'
import type { TFunction } from 'i18next'
import {
  isLocalBrowserConnector,
  localConnectorAuthCancel,
  localConnectorAuthPoll,
  localConnectorAuthStart,
  pollIntervalMs,
  type LocalConnectorAuthResult,
  type LocalConnectorAuthTarget,
  type LocalConnectorAuthTransport,
} from '@/api/local/localConnectorAuth'
import {
  createLocalConnectorAuthSessionSource,
  isBrowserAuthStatus,
} from './localConnectorAuthSessionSource'

export type LocalConnectorAuthTranslate = TFunction

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
      return t('workbench.plugins_local_browser_waiting', '请完成弹出的授权流程，完成后会自动继续')
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
  transport?: LocalConnectorAuthTransport
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
  transport,
}: UseLocalConnectorAuthSessionOptions) {
  const start = transport?.start ?? localConnectorAuthStart
  const poll = transport?.poll ?? localConnectorAuthPoll
  const cancel = transport?.cancel ?? localConnectorAuthCancel
  const pluginKey = target.pluginKey
  const connectorSlug = target.connectorSlug
  const pluginRoot = target.pluginRoot ?? null
  const instance = target.instance ?? undefined
  const intervalMs = pollIntervalMs(target.localAuth)
  const targetUsesBrowser = isLocalBrowserConnector(target)
  const source = useMemo(
    () =>
      createLocalConnectorAuthSessionSource(
        {
          instance,
          pluginKey,
          connectorSlug,
          ...(pluginRoot ? { pluginRoot } : {}),
        },
        { start, poll, cancel },
        targetUsesBrowser,
        intervalMs
      ),
    [
      instance,
      pluginKey,
      connectorSlug,
      pluginRoot,
      start,
      poll,
      cancel,
      targetUsesBrowser,
      intervalMs,
    ]
  )
  const view = source.observe({ t, onSuccess })
  const { status, error, busy } = useSyncExternalStore(
    enabled ? view.subscribe : subscribeIdleResource,
    source.getSnapshot,
    source.getSnapshot
  )
  const usesBrowser = targetUsesBrowser || isBrowserAuthStatus(status)
  return {
    status,
    error,
    busy,
    usesBrowser,
    statusText: localConnectorAuthStatusText(status, { usesBrowser, error, t }),
    qrSrc: status?.qrImage?.dataUrl || null,
    canRetry:
      Boolean(error) ||
      status?.status === 'expired' ||
      status?.status === 'error' ||
      status?.status === 'cancelled',
    retry: source.retry,
    cancelActiveSession: source.cancelActiveSession,
  }
}
