// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { paths } from '@/config/paths'
import { Spinner } from '@/components/ui/spinner'
import { loginWithOidcToken } from '@/apis/user'
import { POST_LOGIN_REDIRECT_KEY, sanitizeRedirectPath } from '@/features/login/constants'

export default function OidcCallbackPage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    // Check if token parameters already exist (redirected from backend)
    const accessToken = searchParams.get('access_token')
    const loginSuccess = searchParams.get('login_success')

    if (accessToken && loginSuccess === 'true') {
      // Backend has completed OIDC authentication, processing token in the same way as CAS

      loginWithOidcToken(accessToken)
        .then(() => {
          console.log(
            'OIDC callback page - token processed successfully, determining redirect target'
          )
          let redirectTarget = paths.chat.getHref()
          if (typeof window !== 'undefined') {
            const loginPath = paths.auth.login.getHref()
            const disallowedRedirects = [loginPath, '/login/oidc']
            const queryRedirect = searchParams.get('redirect')
            const storedRedirect = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY)
            const validQueryRedirect = sanitizeRedirectPath(queryRedirect, disallowedRedirects)
            const validStoredRedirect = sanitizeRedirectPath(storedRedirect, disallowedRedirects)
            redirectTarget = validQueryRedirect || validStoredRedirect || redirectTarget
            sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
          }
          router.replace(redirectTarget)
        })
        .catch(error => {
          console.error('OIDC callback page - token processing failed:', error)
          if (typeof window !== 'undefined') {
            sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
          }
          router.replace(paths.home.getHref())
        })
      return
    }

    // If no token parameters, check code and state (frontend needs to handle OIDC callback)
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const error = searchParams.get('error')

    if (error) {
      console.error('OIDC login error:', error)
      router.replace(paths.home.getHref())
      return
    }

    if (!code || !state) {
      console.error('OIDC callback parameters missing')
      router.replace(paths.home.getHref())
      return
    }

    // If code and state exist, redirect to backend to handle OIDC callback
    window.location.href = `/api/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
  }, [router, searchParams])

  return (
    <div className="flex items-center justify-center smart-h-screen bg-base box-border">
      <div className="bg-surface rounded-xl px-8 py-8 flex flex-col items-center shadow-lg">
        <Spinner size="lg" center />
        <div className="mt-4 text-text-secondary text-base font-medium tracking-wide">
          Processing OpenID Connect login...
        </div>
      </div>
    </div>
  )
}
