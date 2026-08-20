// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CheckCircle2, ShieldCheck, XCircle } from 'lucide-react'
import { oauthAuthorizationApis, OAuthAuthorizationRequest } from '@/apis/oauthProvider'
import { removeToken } from '@/apis/user'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { paths } from '@/config/paths'
import { UserProvider, useUser } from '@/features/common/UserContext'
import { POST_LOGIN_REDIRECT_KEY } from '@/features/login/constants'
import { useTranslation } from '@/hooks/useTranslation'

type DecisionState = 'idle' | 'submitting' | 'approved' | 'denied' | 'error'

function currentTarget() {
  if (typeof window === 'undefined') return paths.auth.oauth_authorize.getHref()
  return `${window.location.pathname}${window.location.search}`
}

function OAuthAuthorizeContent() {
  const { t } = useTranslation('common')
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, isLoading } = useUser()
  const requestId = searchParams.get('request_id') ?? ''
  const [request, setRequest] = useState<OAuthAuthorizationRequest | null>(null)
  const [state, setState] = useState<DecisionState>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    if (isLoading || user || !requestId) return
    const target = currentTarget()
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, target)
    router.replace(`${paths.auth.login.getHref()}?redirect=${encodeURIComponent(target)}`)
  }, [isLoading, requestId, router, user])

  useEffect(() => {
    if (!user || !requestId) return
    oauthAuthorizationApis
      .getRequest(requestId)
      .then(setRequest)
      .catch(loadError => {
        setError(loadError instanceof Error ? loadError.message : t('auth.oauth_authorize.failed'))
        setState('error')
      })
  }, [requestId, t, user])

  async function decide(approved: boolean) {
    setState('submitting')
    setError('')
    try {
      const result = approved
        ? await oauthAuthorizationApis.approve(requestId)
        : await oauthAuthorizationApis.deny(requestId)
      setState(approved ? 'approved' : 'denied')
      window.location.assign(result.redirect_url)
    } catch (decisionError) {
      setError(
        decisionError instanceof Error ? decisionError.message : t('auth.oauth_authorize.failed')
      )
      setState('error')
    }
  }

  function switchAccount() {
    removeToken()
    const target = currentTarget()
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, target)
    router.replace(`${paths.auth.login.getHref()}?redirect=${encodeURIComponent(target)}`)
  }

  if (!requestId) {
    return <OAuthStatus error title={t('auth.oauth_authorize.invalid_title')} />
  }
  if (isLoading || !user || (!request && state !== 'error')) {
    return <OAuthStatus loading title={t('auth.oauth_authorize.loading')} />
  }
  if (state === 'approved' || state === 'denied') {
    return (
      <OAuthStatus
        title={
          state === 'approved'
            ? t('auth.oauth_authorize.redirecting_approved')
            : t('auth.oauth_authorize.redirecting_denied')
        }
      />
    )
  }
  if (!request) {
    return <OAuthStatus error title={error || t('auth.oauth_authorize.failed')} />
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-base px-4 py-8">
      <section className="w-full max-w-md rounded-lg border border-border bg-surface px-6 py-7 shadow-lg">
        <div className="flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <h1 className="mt-5 text-xl font-semibold text-text-primary">
            {t('auth.oauth_authorize.title', { client: request.client_name })}
          </h1>
          <p className="mt-3 text-sm leading-6 text-text-secondary">
            {t('auth.oauth_authorize.description')}
          </p>
          <div className="mt-5 w-full space-y-2 rounded-lg border border-border bg-base px-4 py-3 text-left text-sm">
            <InfoRow label={t('auth.oauth_authorize.application')} value={request.client_name} />
            <InfoRow label={t('auth.oauth_authorize.account')} value={user.user_name} />
            <InfoRow label={t('auth.oauth_authorize.permission')} value={request.scope} />
            <InfoRow label={t('auth.oauth_authorize.redirect_uri')} value={request.redirect_uri} />
          </div>
          <div className="mt-4 w-full rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-left text-sm text-amber-700">
            {t('auth.oauth_authorize.boundary')}
          </div>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          <div className="mt-6 grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
            <Button
              variant="outline"
              className="min-h-11"
              disabled={state === 'submitting'}
              onClick={() => void decide(false)}
              data-testid="oauth-authorize-deny"
            >
              {t('auth.oauth_authorize.deny')}
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={state === 'submitting'}
              onClick={switchAccount}
              data-testid="oauth-authorize-switch-account"
            >
              {t('auth.oauth_authorize.switch_account')}
            </Button>
            <Button
              variant="primary"
              className="min-h-11"
              disabled={state === 'submitting'}
              onClick={() => void decide(true)}
              data-testid="oauth-authorize-approve"
            >
              {t('auth.oauth_authorize.approve')}
            </Button>
          </div>
        </div>
      </section>
    </main>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-text-secondary">{label}</span>
      <span className="truncate font-medium text-text-primary">{value}</span>
    </div>
  )
}

function OAuthStatus({
  title,
  loading = false,
  error = false,
}: {
  title: string
  loading?: boolean
  error?: boolean
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-base px-4 py-8">
      <section className="flex w-full max-w-md flex-col items-center rounded-lg border border-border bg-surface px-6 py-8 text-center shadow-lg">
        {loading ? (
          <Spinner size="lg" center />
        ) : error ? (
          <XCircle className="h-8 w-8 text-red-500" />
        ) : (
          <CheckCircle2 className="h-8 w-8 text-primary" />
        )}
        <h1 className="mt-4 text-lg font-semibold text-text-primary">{title}</h1>
      </section>
    </main>
  )
}

export default function OAuthAuthorizePage() {
  return (
    <UserProvider>
      <OAuthAuthorizeContent />
    </UserProvider>
  )
}
