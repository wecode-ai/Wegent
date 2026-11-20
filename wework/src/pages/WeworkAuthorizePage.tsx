import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useAuth } from '@/features/auth/useAuth'
import { createWeworkAuthorizationResource } from './weworkAuthorizationResource'

export function WeworkAuthorizePage() {
  const { t } = useTranslation('common')
  const { user, isLoading: authLoading } = useAuth()
  const sessionId = new URLSearchParams(window.location.search).get('session_id')
  const backendUrl =
    localStorage.getItem('wework.cloudConnection.backendUrl') || 'http://127.0.0.1:8000'
  const userId = user?.id
  const source = useMemo(
    () => createWeworkAuthorizationResource(sessionId, userId, backendUrl),
    [sessionId, userId, backendUrl]
  )
  const subscribe = useCallback(
    (notify: () => void) =>
      sessionId && !authLoading ? source.subscribe(notify) : subscribeIdleResource(),
    [source, sessionId, authLoading]
  )
  const snapshot = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  const state = !sessionId
    ? {
        status: 'error',
        message: t('workbench.wework_authorize_missing_session', '授权会话 ID 缺失'),
      }
    : snapshot.status === 'error'
      ? {
          status: 'error',
          message:
            snapshot.error instanceof Error
              ? snapshot.error.message
              : t('workbench.wework_authorize_failed', '授权失败，请重试'),
        }
      : snapshot.status === 'ready' && snapshot.data === 'approved'
        ? {
            status: 'success',
            message: t('workbench.wework_authorize_success', '授权成功！请返回 Wework 应用继续。'),
          }
        : {
            status: 'loading',
            message: t('workbench.cloud_connection_waiting_authorization', '等待云端授权'),
          }

  return (
    <div className="flex h-screen w-full items-center justify-center bg-background">
      <div className="flex w-full max-w-md flex-col items-center gap-6 rounded-2xl border border-border bg-surface p-8 shadow-lg">
        {state.status === 'loading' && (
          <>
            <Loader2 className="h-16 w-16 animate-spin text-primary" />
            <div className="text-center">
              <h1 className="text-xl font-semibold text-text-primary">{state.message}</h1>
              <p className="mt-2 text-sm text-text-secondary">
                {t('workbench.wework_authorize_connecting', '正在连接到 Wework 云端...')}
              </p>
            </div>
          </>
        )}

        {state.status === 'success' && (
          <>
            <CheckCircle2 className="h-16 w-16 text-success wework:text-green-500" />
            <div className="text-center">
              <h1 className="text-xl font-semibold text-text-primary">{state.message}</h1>
              <p className="mt-2 text-sm text-text-secondary">
                {t('workbench.wework_authorize_window_will_close', '此窗口将自动关闭')}
              </p>
            </div>
          </>
        )}

        {state.status === 'error' && (
          <>
            <XCircle className="h-16 w-16 text-destructive wework:text-red-500" />
            <div className="text-center">
              <h1 className="text-xl font-semibold text-text-primary">
                {t('workbench.wework_authorize_failed_title', '授权失败')}
              </h1>
              <p className="mt-2 text-sm text-text-secondary">{state.message}</p>
              <button
                type="button"
                onClick={() => window.close()}
                className="mt-4 rounded-lg bg-text-primary px-4 py-2 text-sm font-medium text-background hover:bg-text-primary/90"
                data-testid="wework-authorize-close"
              >
                {t('workbench.wework_authorize_close_window', '关闭窗口')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
