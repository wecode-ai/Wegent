// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CheckCircle2, Cloud, XCircle } from 'lucide-react'
import { userApis } from '@/apis/user'
import { Button } from '@/components/ui/button'
import { paths } from '@/config/paths'
import { POST_LOGIN_REDIRECT_KEY } from '@/features/login/constants'
import { UserProvider, useUser } from '@/features/common/UserContext'
import { useTranslation } from '@/hooks/useTranslation'

type AuthorizationState = 'idle' | 'submitting' | 'approved' | 'declined' | 'error'

function currentRedirectTarget(): string {
  if (typeof window === 'undefined') return '/wework/authorize'
  return `${window.location.pathname}${window.location.search}`
}

function WeworkAuthorizeContent() {
  const { t } = useTranslation('common')
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, isLoading } = useUser()
  const sessionId = searchParams.get('session_id') ?? ''
  const [state, setState] = useState<AuthorizationState>('idle')
  const [error, setError] = useState<string | null>(null)
  const backendHost = useMemo(() => {
    if (typeof window === 'undefined') return 'Wegent'
    return window.location.host
  }, [])

  useEffect(() => {
    if (isLoading || user || !sessionId) return
    const redirectTarget = currentRedirectTarget()
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, redirectTarget)
    router.replace(`${paths.auth.login.getHref()}?redirect=${encodeURIComponent(redirectTarget)}`)
  }, [isLoading, router, sessionId, user])

  async function handleApprove() {
    setState('submitting')
    setError(null)
    try {
      await userApis.approveWeworkAuthSession(sessionId)
      setState('approved')
    } catch (approveError) {
      setError(
        approveError instanceof Error
          ? approveError.message
          : t('auth.wework_authorize.authorization_failed')
      )
      setState('error')
    }
  }

  async function handleDecline() {
    setState('submitting')
    setError(null)
    try {
      await userApis.declineWeworkAuthSession(sessionId)
      setState('declined')
    } catch (declineError) {
      setError(
        declineError instanceof Error
          ? declineError.message
          : t('auth.wework_authorize.authorization_failed')
      )
      setState('error')
    }
  }

  if (!sessionId) {
    return (
      <AuthorizeShell>
        <StatusMessage
          icon={<XCircle className="h-8 w-8 text-red-500" />}
          title={t('auth.wework_authorize.invalid_title')}
          description={t('auth.wework_authorize.invalid_description')}
        />
      </AuthorizeShell>
    )
  }

  if (isLoading || !user) {
    return (
      <AuthorizeShell>
        <StatusMessage
          icon={<Cloud className="h-8 w-8 text-primary" />}
          title={t('auth.wework_authorize.loading_title')}
          description={t('auth.wework_authorize.loading_description')}
        />
      </AuthorizeShell>
    )
  }

  if (state === 'approved') {
    return (
      <AuthorizeShell>
        <StatusMessage
          icon={<CheckCircle2 className="h-8 w-8 text-primary" />}
          title={t('auth.wework_authorize.approved_title')}
          description={t('auth.wework_authorize.approved_description')}
        />
      </AuthorizeShell>
    )
  }

  if (state === 'declined') {
    return (
      <AuthorizeShell>
        <StatusMessage
          icon={<XCircle className="h-8 w-8 text-text-secondary" />}
          title={t('auth.wework_authorize.declined_title')}
          description={t('auth.wework_authorize.declined_description')}
        />
      </AuthorizeShell>
    )
  }

  return (
    <AuthorizeShell>
      <div className="flex flex-col items-center text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Cloud className="h-6 w-6" />
        </div>
        <h1 className="mt-5 text-xl font-semibold text-text-primary">
          {t('auth.wework_authorize.title')}
        </h1>
        <p className="mt-3 text-sm leading-6 text-text-secondary">
          {t('auth.wework_authorize.description')}
        </p>
        <div className="mt-5 w-full rounded-lg border border-border bg-base px-4 py-3 text-left text-sm">
          <div className="flex justify-between gap-3">
            <span className="text-text-secondary">{t('auth.wework_authorize.cloud_label')}</span>
            <span className="truncate font-medium text-text-primary">{backendHost}</span>
          </div>
          <div className="mt-2 flex justify-between gap-3">
            <span className="text-text-secondary">{t('auth.wework_authorize.account_label')}</span>
            <span className="truncate font-medium text-text-primary">{user.user_name}</span>
          </div>
        </div>
        {error && (
          <div className="mt-4 w-full rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-left text-sm text-red-600">
            {error}
          </div>
        )}
        <div className="mt-6 flex w-full gap-3">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            disabled={state === 'submitting'}
            onClick={handleDecline}
          >
            {t('auth.wework_authorize.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            className="flex-1"
            disabled={state === 'submitting'}
            onClick={handleApprove}
          >
            {t('auth.wework_authorize.approve')}
          </Button>
        </div>
      </div>
    </AuthorizeShell>
  )
}

function AuthorizeShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-base px-4 py-8">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface px-6 py-7 shadow-lg">
        {children}
      </div>
    </div>
  )
}

function StatusMessage({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex flex-col items-center text-center">
      {icon}
      <h1 className="mt-4 text-lg font-semibold text-text-primary">{title}</h1>
      <p className="mt-2 text-sm leading-6 text-text-secondary">{description}</p>
    </div>
  )
}

export default function WeworkAuthorizePage() {
  return (
    <UserProvider>
      <WeworkAuthorizeContent />
    </UserProvider>
  )
}
