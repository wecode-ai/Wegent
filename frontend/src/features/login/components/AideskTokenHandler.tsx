// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import { apiClient } from '@/apis/client'
import { setToken, getToken } from '@/apis/user'

interface AideskLoginResponse {
  access_token: string
  token_type: string
  user: {
    id: number
    user_name: string
    email: string
    role: string
    auth_source: string
  }
}

/**
 * Aidesk Token Handler Component
 *
 * Handles authentication from 口袋 App WebView.
 * When URL contains source=aidesk, extracts parameters and calls backend for authentication.
 *
 * Similar to DingTalk authentication flow:
 * 1. Detect source=aidesk in URL parameters
 * 2. Call backend to verify signature and get JWT token
 * 3. Store token using setToken (same as DingTalk)
 * 4. Clean URL parameters and dispatch login success event
 */
export default function AideskTokenHandler() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isProcessing, setIsProcessing] = useState(false)
  const processedRef = useRef(false)

  useEffect(() => {
    const source = searchParams.get('source')
    const username = searchParams.get('username')
    const timestamp = searchParams.get('timestamp')
    const sign = searchParams.get('sign')

    // Only process if source is aidesk and all params are present
    if (source !== 'aidesk' || !username || !timestamp || !sign) {
      return
    }

    // Prevent duplicate processing
    if (isProcessing || processedRef.current) {
      return
    }

    // Helper function to clean URL parameters
    const cleanUrlParams = () => {
      const url = new URL(window.location.href)
      url.searchParams.delete('source')
      url.searchParams.delete('username')
      url.searchParams.delete('timestamp')
      url.searchParams.delete('sign')
      router.replace(url.pathname + url.search)
    }

    // If user is already logged in, skip aidesk login flow and just clean URL params
    const existingToken = getToken()
    if (existingToken) {
      console.log('[Aidesk] User already logged in, skipping aidesk login flow')
      processedRef.current = true
      cleanUrlParams()
      return
    }

    const handleAideskLogin = async () => {
      setIsProcessing(true)
      processedRef.current = true

      try {
        console.log('[Aidesk] Processing login for user:', username)

        // Call backend to verify signature and get token
        const response = await apiClient.post<AideskLoginResponse>('/internal/auth/aidesk/login', {
          source,
          username,
          timestamp,
          sign,
        })

        if (response.access_token) {
          // Store token using shared setToken function (same as DingTalk)
          setToken(response.access_token)

          console.log('[Aidesk] Login successful for user:', response.user.user_name)

          toast({
            title: t('common:auth.login_success'),
          })

          // Dispatch login success event FIRST to trigger UserContext refresh
          // This ensures the user state is updated before URL cleanup
          window.dispatchEvent(new Event('aidesk-login-success'))

          // Clean URL parameters after a short delay to allow UserContext to process
          setTimeout(() => {
            const url = new URL(window.location.href)
            url.searchParams.delete('source')
            url.searchParams.delete('username')
            url.searchParams.delete('timestamp')
            url.searchParams.delete('sign')
            router.replace(url.pathname + url.search)
          }, 200)
        }
      } catch (error: unknown) {
        console.error('[Aidesk] Login failed:', error)

        const errorMessage = error instanceof Error ? error.message : 'Authentication failed'

        toast({
          variant: 'destructive',
          title: t('common:auth.login_failed'),
          description: errorMessage,
        })

        // Clean URL parameters even on error
        const url = new URL(window.location.href)
        url.searchParams.delete('source')
        url.searchParams.delete('username')
        url.searchParams.delete('timestamp')
        url.searchParams.delete('sign')
        router.replace(url.pathname + url.search)
      } finally {
        setIsProcessing(false)
      }
    }

    handleAideskLogin()
  }, [searchParams, router, t, toast, isProcessing])

  return null
}
