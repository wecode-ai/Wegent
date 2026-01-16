// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'

/**
 * OIDC Token Handler Component
 *
 * Handles token parameters from OIDC callback redirects
 * When backend OIDC callback succeeds, it redirects to /login/oidc?access_token=xxx&token_type=bearer&login_success=true
 * This component is responsible for extracting these parameters and storing them in localStorage
 */
export default function OidcTokenHandler() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const accessToken = searchParams.get('access_token')
    const error = searchParams.get('error')
    const tokenType = searchParams.get('token_type')
    const loginSuccess = searchParams.get('login_success')
    const errorMessage = searchParams.get('message')

    if (error) {
      console.error('OIDC login failed:', error, errorMessage)
      toast({
        variant: 'destructive',
        title: t('common:auth.oidc_login_failed'),
        description: errorMessage || error,
      })

      const url = new URL(window.location.href)
      url.searchParams.delete('error')
      url.searchParams.delete('message')
      router.replace(url.pathname + url.search)
      return
    }

    if (loginSuccess === 'true' && accessToken) {
      localStorage.setItem('auth_token', accessToken)
      localStorage.setItem('token_type', tokenType || 'bearer')

      toast({
        title: t('common:auth.login_success'),
      })

      const url = new URL(window.location.href)
      url.searchParams.delete('access_token')
      url.searchParams.delete('token_type')
      url.searchParams.delete('login_success')

      router.replace(url.pathname + url.search)

      setTimeout(() => {
        console.log('Trigger user status refresh')
        window.dispatchEvent(new Event('common:oidc-login-success'))
      }, 100)
    }
  }, [router, searchParams, t, toast])

  return null
}
