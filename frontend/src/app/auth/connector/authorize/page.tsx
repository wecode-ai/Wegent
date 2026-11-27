// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ApiError } from '@/apis/client'
import { removeToken } from '@/apis/user'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { paths } from '@/config/paths'
import { UserProvider, useUser } from '@/features/common/UserContext'
import { POST_LOGIN_REDIRECT_KEY } from '@/features/login/constants'
import {
  authorizeConnectorApp,
  connectorOAuthErrorMessage,
} from '@/features/settings/connectorOAuth'
import { useSessionToken } from '@/hooks/useSessionToken'
import { useTranslation } from '@/hooks/useTranslation'

const STORAGE_KEY = 'externalConnectorAuthorization'
const TRANSLATION_KEY = 'auth.connector_authorize'

function serializeLink(slug: string, ticket: string) {
  return new URLSearchParams({ slug, ticket }).toString()
}

function ConnectorAuthorizeContent() {
  const { t } = useTranslation('common')
  const { user, isLoading } = useUser()
  const [link, setLink] = useState<{ slug: string; ticket: string } | null>(null)

  useLayoutEffect(() => {
    const updateLink = () => {
      // Keep the ticket in this tab while Wegent sends the user through login.
      const fragment = window.location.hash.slice(1)
      const params = new URLSearchParams(fragment || sessionStorage.getItem(STORAGE_KEY) || '')
      const slug = params.get('slug')
      const ticket = params.get('ticket')
      if (fragment) {
        const { pathname, search } = window.location
        window.history.replaceState(window.history.state, '', pathname + search)
      }
      if (!slug || !ticket) {
        sessionStorage.removeItem(STORAGE_KEY)
        setLink(null)
        return
      }
      sessionStorage.setItem(STORAGE_KEY, serializeLink(slug, ticket))
      setLink({ slug, ticket })
    }

    updateLink()
    window.addEventListener('hashchange', updateLink)
    return () => window.removeEventListener('hashchange', updateLink)
  }, [])

  if (isLoading) return <Spinner size="lg" center />
  if (!link) return <p role="alert">{t(`${TRANSLATION_KEY}.invalid`)}</p>
  if (!user) return <Spinner size="lg" center />

  return (
    <ConnectorConsent
      key={`${user.id}:${link.slug}:${link.ticket}`}
      userName={user.user_name}
      slug={link.slug}
      ticket={link.ticket}
    />
  )
}

function ConnectorConsent({
  userName,
  slug,
  ticket,
}: {
  userName: string
  slug: string
  ticket: string
}) {
  const { t } = useTranslation('common')
  const router = useRouter()
  const active = useRef(false)
  const [state, setState] = useState<'idle' | 'submitting' | 'success'>('idle')
  const [error, setError] = useState('')

  useLayoutEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  const authorize = async () => {
    setError('')
    setState('submitting')
    const link = serializeLink(slug, ticket)
    const isCurrent = () => active.current && sessionStorage.getItem(STORAGE_KEY) === link
    try {
      await authorizeConnectorApp(slug, { authorizationTicket: ticket, isCurrent })
      if (!isCurrent()) return
      sessionStorage.removeItem(STORAGE_KEY)
      setState('success')
    } catch (cause) {
      if (!isCurrent()) return
      if (cause instanceof ApiError && cause.errorCode === 'CONNECTOR_ALREADY_AUTHORIZED') {
        sessionStorage.removeItem(STORAGE_KEY)
        setState('success')
        return
      }
      setState('idle')
      if (cause instanceof ApiError && cause.status === 403) {
        setError(t(`${TRANSLATION_KEY}.wrong_account`))
      } else if (cause instanceof ApiError && cause.status === 400) {
        setError(t(`${TRANSLATION_KEY}.invalid`))
      } else {
        setError(connectorOAuthErrorMessage(t, cause))
      }
    }
  }

  const switchAccount = () => {
    removeToken()
    const target = paths.auth.connector_authorize.getHref()
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, target)
    router.replace(`${paths.auth.login.getHref()}?redirect=${encodeURIComponent(target)}`)
  }

  if (state === 'success') {
    return (
      <p role="status" data-testid="external-connector-authorized">
        {t(`${TRANSLATION_KEY}.complete`)}
      </p>
    )
  }

  return (
    <>
      <p className="mt-3 break-words text-sm text-text-secondary">
        {t(`${TRANSLATION_KEY}.description`, { slug, user: userName })}
      </p>
      {error && (
        <p className="mt-3 text-sm text-error" role="alert">
          {error}
        </p>
      )}
      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          variant="primary"
          className="min-h-11"
          disabled={state === 'submitting'}
          onClick={() => void authorize()}
          data-testid="authorize-external-connector"
        >
          {state === 'submitting' && <Spinner size="sm" />}
          {t('integrations.connector_apps.authorize')}
        </Button>
        <Button
          variant="outline"
          className="min-h-11"
          onClick={switchAccount}
          disabled={state === 'submitting'}
          data-testid="switch-external-connector-account"
        >
          {t(`${TRANSLATION_KEY}.switch_account`)}
        </Button>
      </div>
    </>
  )
}

export default function ConnectorAuthorizePage() {
  const { t } = useTranslation('common')
  const sessionToken = useSessionToken()
  return (
    <UserProvider key={sessionToken ?? ''}>
      <main className="flex min-h-screen items-center justify-center bg-base px-4 py-8">
        <section className="w-full max-w-md rounded-lg border border-border bg-surface p-6">
          <h1 className="mb-3 text-xl font-semibold">{t(`${TRANSLATION_KEY}.title`)}</h1>
          <ConnectorAuthorizeContent />
        </section>
      </main>
    </UserProvider>
  )
}
