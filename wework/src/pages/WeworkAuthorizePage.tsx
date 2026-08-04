import { useEffect, useState } from 'react'
import { Loader2, CheckCircle2, XCircle, AlertCircle } from 'lucide-react'
import { createHttpClient } from '@/api/http'
import { useTranslation } from '@/hooks/useTranslation'
import { useAuth } from '@/features/auth/useAuth'
import { navigateTo } from '@/lib/navigation'

interface AuthorizeState {
  status: 'loading' | 'success' | 'error' | 'expired'
  message: string
}

export function WeworkAuthorizePage() {
  const { t } = useTranslation('common')
  const { user, isLoading: authLoading } = useAuth()
  const sessionId = new URLSearchParams(window.location.search).get('session_id')
  const [state, setState] = useState<AuthorizeState>(() =>
    sessionId
      ? {
          status: 'loading',
          message: t('workbench.cloud_connection_waiting_authorization', '等待云端授权'),
        }
      : {
          status: 'error',
          message: t('workbench.wework_authorize_missing_session', '授权会话 ID 缺失'),
        }
  )

  useEffect(() => {
    if (!sessionId) return

    if (authLoading) return

    if (!user) {
      const returnUrl = `/auth/wework/authorize?session_id=${encodeURIComponent(sessionId)}`
      navigateTo(`/login?redirect=${encodeURIComponent(returnUrl)}`)
      return
    }

    const backendUrl =
      localStorage.getItem('wework.cloudConnection.backendUrl') || 'http://127.0.0.1:8000'

    const approveSession = async () => {
      try {
        const token = localStorage.getItem('wework.cloudConnection.token') || null
        const client = createHttpClient({
          baseUrl: backendUrl,
          getToken: () => token,
          redirectOnUnauthorized: false,
        })
        await client.post(`/auth/wework/sessions/${sessionId}/approve`)

        setState({
          status: 'success',
          message: t('workbench.wework_authorize_success', '授权成功！请返回 Wework 应用继续。'),
        })

        setTimeout(() => {
          window.close()
        }, 3000)
      } catch (error) {
        console.error('[WeworkAuthorize] Failed to approve session', error)

        const errorMessage =
          error instanceof Error
            ? error.message
            : t('workbench.wework_authorize_failed', '授权失败，请重试')

        setState({
          status: 'error',
          message: errorMessage,
        })
      }
    }

    void approveSession()
  }, [user, authLoading, sessionId, t])

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
            <CheckCircle2 className="h-16 w-16 text-green-500" />
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
            <XCircle className="h-16 w-16 text-red-500" />
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

        {state.status === 'expired' && (
          <>
            <AlertCircle className="h-16 w-16 text-orange-500" />
            <div className="text-center">
              <h1 className="text-xl font-semibold text-text-primary">
                {t('workbench.wework_authorize_session_expired', '授权会话已过期')}
              </h1>
              <p className="mt-2 text-sm text-text-secondary">{state.message}</p>
              <button
                type="button"
                onClick={() => window.close()}
                className="mt-4 rounded-lg bg-text-primary px-4 py-2 text-sm font-medium text-background hover:bg-text-primary/90"
                data-testid="wework-authorize-expired-close"
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
