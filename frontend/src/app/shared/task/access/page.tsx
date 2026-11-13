// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { taskApis, type TaskAccessShareInfo } from '@/apis/tasks'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import TopNavigation from '@/features/layout/TopNavigation'
import { useTranslation } from '@/hooks/useTranslation'
import { useSessionToken } from '@/hooks/useSessionToken'

function TaskAccessContent() {
  const router = useRouter()
  const token = useSearchParams().get('token')
  const sessionToken = useSessionToken()
  const [loadAttempt, setLoadAttempt] = useState(0)
  const scope = JSON.stringify([token, sessionToken, loadAttempt])
  const currentScope = useRef(scope)
  currentScope.current = scope
  const { t } = useTranslation('shared-task')
  const [preview, setPreview] = useState<{ scope: string; info: TaskAccessShareInfo } | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [pending, setPending] = useState(false)
  const [loginRequired, setLoginRequired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const info = preview?.scope === scope ? preview.info : null

  useEffect(() => {
    let cancelled = false
    currentScope.current = scope
    setPreview(null)
    setError(null)
    setPending(false)
    setIsSubmitting(false)
    setLoginRequired(false)
    setIsLoading(true)
    if (!token) {
      setError(t('error_invalid_link'))
      setIsLoading(false)
      return
    }
    taskApis
      .getTaskAccessShareInfo(token)
      .then(data => {
        if (cancelled) return
        if (data.resource_type !== 'Task' || data.is_expired) {
          setError(t('error_invalid_link'))
          return
        }
        setPreview({ scope, info: data })
      })
      .catch((err: Error & { status?: number }) => {
        if (cancelled) return
        setLoginRequired(err.status === 401)
        setError(
          t(
            err.status === 401
              ? 'legacy_login_required'
              : err.status === 403
                ? 'legacy_access_required'
                : err.status === 400 || err.status === 404
                  ? 'error_invalid_link'
                  : 'error_load_failed'
          )
        )
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
      if (currentScope.current === scope) currentScope.current = ''
    }
  }, [token, scope, t])

  const login = () => {
    if (!token) return
    const target = `/shared/task/access?token=${encodeURIComponent(token)}`
    router.push(`/login?redirect=${encodeURIComponent(target)}`)
  }

  const requestAccess = async () => {
    if (!token || !info || isSubmitting) return
    const requestScope = scope
    setIsSubmitting(true)
    setError(null)
    try {
      const response = await taskApis.joinTaskAccessShare(token)
      if (currentScope.current !== requestScope) return
      if (response.resource_type !== 'Task' || response.resource_id !== info.resource_id) {
        setError(t('error_load_failed'))
      } else if (response.status === 'pending') {
        setPending(true)
      } else if (response.status === 'approved') {
        router.push(`/chat?taskId=${response.copied_resource_id || response.resource_id}`)
      }
    } catch (err) {
      if (currentScope.current !== requestScope) return
      const failure = err as Error & { status?: number }
      if (
        failure.status === 400 &&
        (failure.message === 'Already have access to this resource' ||
          failure.message === 'Cannot join your own resource')
      ) {
        router.push(`/chat?taskId=${info.resource_id}`)
      } else if (failure.status === 400 && failure.message === 'Request already pending approval') {
        setPending(true)
      } else {
        setLoginRequired(failure.status === 401)
        setError(t(failure.status === 403 ? 'legacy_access_required' : 'error_load_failed'))
      }
    } finally {
      if (currentScope.current === requestScope) setIsSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col smart-h-screen bg-base text-text-primary">
      <TopNavigation activePage="chat" variant="standalone" showLogo />
      <main className="flex-1 flex items-center justify-center p-4">
        <Card padding="lg" className="w-full max-w-lg space-y-4">
          {isLoading ? (
            <Spinner />
          ) : (
            <>
              <h1 className="text-xl font-semibold">{info?.resource_name || t('shared_task')}</h1>
              {info && (
                <>
                  <p className="text-sm text-text-muted">
                    {t('shared_by')}: {info.owner_user_name}
                  </p>
                  <p>
                    {t(info.require_approval ? 'access_approval_notice' : 'access_join_notice')}
                  </p>
                </>
              )}
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {token && !info && !loginRequired && error && (
                <Button
                  variant="outline"
                  className="min-h-11"
                  data-testid="task-access-retry"
                  onClick={() => setLoadAttempt(attempt => attempt + 1)}
                >
                  {t('access_retry')}
                </Button>
              )}
              {pending && (
                <Alert data-testid="task-access-pending">
                  <AlertDescription>{t('access_pending')}</AlertDescription>
                </Alert>
              )}
              {(!sessionToken || loginRequired) && (info || loginRequired) ? (
                <Button
                  variant="primary"
                  className="min-h-11"
                  data-testid="task-access-login"
                  onClick={login}
                >
                  {t('login')}
                </Button>
              ) : info ? (
                <Button
                  variant="primary"
                  className="min-h-11"
                  data-testid="task-access-request"
                  disabled={isSubmitting}
                  onClick={requestAccess}
                >
                  {t(pending ? 'access_check' : 'access_request')}
                </Button>
              ) : null}
            </>
          )}
        </Card>
      </main>
    </div>
  )
}

export default function TaskAccessPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <TaskAccessContent />
    </Suspense>
  )
}
