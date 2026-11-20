import type { TFunction } from 'i18next'
import { beginOperation } from '@/telemetry/operationBus'
import { pluginTelemetryIdentityFromParts } from '@/telemetry/pluginIdentity'
import type {
  LocalConnectorAuthResult,
  LocalConnectorAuthTarget,
  LocalConnectorAuthTransport,
} from '@/api/local/localConnectorAuth'

export function isBrowserAuthStatus(status: LocalConnectorAuthResult | null | undefined): boolean {
  return status?.status === 'waiting_browser' || status?.status === 'verifying'
}

function startErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string')
    return error.message
  return fallback
}

interface SessionSnapshot {
  status: LocalConnectorAuthResult | null
  error: string | null
  busy: boolean
}
interface SessionObserver {
  t: TFunction
  onSuccess(result: LocalConnectorAuthResult): void
}

/** One exact native target owns authorization attempts, polling and cancellation. */
export function createLocalConnectorAuthSessionSource(
  target: LocalConnectorAuthTarget,
  transport: LocalConnectorAuthTransport,
  browserMode: boolean,
  intervalMs: number
) {
  const listeners = new Set<() => void>()
  const cancelled = new Set<string>()
  let snapshot: SessionSnapshot = { status: null, error: null, busy: false }
  let observer: SessionObserver | null = null
  let disposeAttempt: (() => void) | null = null
  let cancelAttempt: (() => void) | null = null
  let revision = 0
  const publish = (patch: Partial<SessionSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }
  const cancelSession = (id: string) => {
    if (cancelled.has(id)) return
    cancelled.add(id)
    void transport.cancel(target, id).catch(() => undefined)
  }
  function begin() {
    if (!listeners.size) return
    const owner = ++revision
    const attempt = beginOperation('plugin.authorize', {
      properties: pluginTelemetryIdentityFromParts({
        marketplace: 'local',
        pluginKey: target.pluginKey,
      }),
    })
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let sessionId: string | null = null
    let authenticated = false
    let disposed = false
    const isCurrent = () => !disposed && revision === owner && listeners.size > 0
    const terminalError = (result: LocalConnectorAuthResult, usesBrowser: boolean) => {
      if (result.status === 'cancelled') attempt.cancel()
      else attempt.fail('confirm')
      return (
        result.hint ||
        (usesBrowser
          ? observer!.t(
              'workbench.plugins_local_browser_failed',
              '浏览器授权未完成，请重新开始登录'
            )
          : observer!.t('workbench.plugins_local_qr_expired', '二维码已失效，请重新开始登录'))
      )
    }
    const terminal = (result: LocalConnectorAuthResult) =>
      result.status === 'error' || result.status === 'expired' || result.status === 'cancelled'
    const succeed = (result: LocalConnectorAuthResult) => {
      authenticated = true
      attempt.succeed()
      if (isCurrent()) observer?.onSuccess(result)
    }
    const poll = async (startedAsBrowser: boolean) => {
      if (!isCurrent()) return
      try {
        const next = await transport.poll(target, sessionId)
        if (!isCurrent()) return
        if (next.status === 'ok') authenticated = true
        publish({
          status: {
            ...next,
            qrImage: next.qrImage ?? snapshot.status?.qrImage ?? null,
            qrPath: next.qrPath ?? snapshot.status?.qrPath ?? null,
          },
        })
        if (!isCurrent()) return
        if (next.status === 'ok') {
          succeed(next)
          return
        }
        if (terminal(next)) {
          publish({ error: terminalError(next, startedAsBrowser || isBrowserAuthStatus(next)) })
          return
        }
        pollTimer = setTimeout(() => void poll(startedAsBrowser), intervalMs)
      } catch (error) {
        if (!isCurrent()) return
        attempt.fail('request')
        publish({
          error:
            error instanceof Error
              ? error.message
              : observer!.t('workbench.plugins_local_auth_poll_failed', '检查登录状态失败'),
        })
      }
    }
    const start = async () => {
      if (!isCurrent()) return
      publish({ busy: true, error: null, status: null })
      if (!isCurrent()) return
      try {
        const started = await transport.start(target)
        if (!isCurrent()) {
          if (started.sessionId) cancelSession(started.sessionId)
          return
        }
        sessionId = started.sessionId ?? null
        if (started.status === 'ok') authenticated = true
        publish({ error: null, status: started })
        if (!isCurrent()) return
        if (started.status === 'ok') {
          succeed(started)
          return
        }
        const startedAsBrowser = browserMode || isBrowserAuthStatus(started)
        if (terminal(started)) {
          publish({ error: terminalError(started, startedAsBrowser) })
          return
        }
        pollTimer = setTimeout(() => void poll(startedAsBrowser), intervalMs)
      } catch (error) {
        if (!isCurrent()) return
        attempt.fail('request')
        publish({
          error: startErrorMessage(
            error,
            browserMode
              ? observer!.t('workbench.plugins_local_browser_start_failed', '无法启动浏览器授权')
              : observer!.t('workbench.plugins_local_qr_start_failed', '无法生成登录二维码')
          ),
        })
      } finally {
        if (isCurrent()) publish({ busy: false })
      }
    }
    const dispose = () => {
      if (disposed) return
      disposed = true
      revision++
      clearTimeout(startTimer)
      clearTimeout(pollTimer)
      attempt.cancel()
      if (sessionId && !authenticated) cancelSession(sessionId)
    }
    disposeAttempt = dispose
    cancelAttempt = () => {
      dispose()
      publish({ busy: false })
    }
    // A discarded first subscription creates no native authorization window.
    const startTimer = setTimeout(() => void start(), 0)
  }
  return {
    getSnapshot: () => snapshot,
    retry() {
      disposeAttempt?.()
      disposeAttempt = null
      cancelAttempt = null
      begin()
    },
    cancelActiveSession() {
      cancelAttempt?.()
    },
    observe(next: SessionObserver) {
      return {
        subscribe(listener: () => void) {
          observer = next
          listeners.add(listener)
          if (!disposeAttempt) begin()
          return () => {
            listeners.delete(listener)
            // Metadata handoff retains the same native attempt; true detach cancels it.
            queueMicrotask(() => {
              if (listeners.size) return
              disposeAttempt?.()
              disposeAttempt = null
              cancelAttempt = null
              observer = null
            })
          }
        },
      }
    },
  }
}
