// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * DingTalk authentication page.
 * This page handles the DingTalk OAuth flow:
 * 1. Check if in DingTalk environment
 * 2. If not, redirect to fallback URL
 * 3. If yes, trigger DingTalk auth and login
 */
import { useEffect, useState } from 'react'
import { redirectIfNotDingTalk, getDingTalkConfig } from '@/dingtalk/lib/environment'
import { useDingTalkAuth } from '@/dingtalk/hooks/useDingTalkAuth'

export default function DingTalkAuthPage() {
  const [checking, setChecking] = useState(true)
  const { login, loading, error } = useDingTalkAuth()

  useEffect(() => {
    const init = async () => {
      // Security: Redirect if not in DingTalk environment
      const redirected = await redirectIfNotDingTalk()
      if (redirected) return

      setChecking(false)

      // Auto-trigger login
      try {
        await login()
      } catch {
        // On error, redirect to fallback
        const config = getDingTalkConfig()
        window.location.href = config.fallbackUrl
      }
    }

    init()
  }, [login])

  // Show loading during environment check
  if (checking || loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-base">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
          <p className="mt-4 text-text-secondary">正在登录...</p>
        </div>
      </div>
    )
  }

  // Show error (briefly before redirect)
  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-base">
        <div className="text-center">
          <p className="text-red-500">{error}</p>
          <p className="mt-2 text-text-secondary">正在跳转...</p>
        </div>
      </div>
    )
  }

  return null
}
