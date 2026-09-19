// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { paths } from '@/config/paths'
import { openNavigationHref } from '@/config/coding-route'
import { useTranslation } from '@/hooks/useTranslation'
import LanguageSwitcher from '@/components/LanguageSwitcher'
import PoweredByFooter from '@/components/common/PoweredByFooter'
import { getToken } from '@/apis/user'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import { getLastTab } from '@/utils/userPreferences'
import { Button } from '@/components/ui/button'
import { isAuthModeDingTalk } from '@/dingtalk/lib/environment'
import AideskTokenHandler from '@/features/login/components/AideskTokenHandler'

export default function Home() {
  const router = useRouter()
  const { t } = useTranslation('common')

  const redirectToLastTab = useCallback(() => {
    const lastTab = getLastTab()
    if (lastTab === 'code') {
      openNavigationHref(router, paths.code.getHref())
    } else if (lastTab === 'wiki') {
      router.replace(paths.wiki.getHref())
    } else {
      router.replace(paths.chat.getHref())
    }
  }, [router])

  // Redirect logic with priority: logged in user > DingTalk mode
  // Also listen for Aidesk login success event
  useEffect(() => {
    // Priority 1: If user is already logged in, redirect directly (skip Aidesk login flow)
    const token = getToken()
    if (token) {
      redirectToLastTab()
      return
    }

    // Priority 2: DingTalk mode - redirect to DingTalk auth
    if (isAuthModeDingTalk()) {
      router.replace('/auth/dingtalk')
      return
    }

    // Listen for Aidesk login success event and redirect to chat
    const handleAideskLoginSuccess = () => {
      redirectToLastTab()
    }

    window.addEventListener('aidesk-login-success', handleAideskLoginSuccess)
    return () => {
      window.removeEventListener('aidesk-login-success', handleAideskLoginSuccess)
    }
  }, [redirectToLastTab, router])

  const handleGetStarted = () => {
    const token = getToken()
    if (token) {
      redirectToLastTab()
    } else {
      router.push(paths.auth.login.getHref())
    }
  }

  // Check if user is already logged in - used to skip AideskTokenHandler rendering
  const isLoggedIn = !!getToken()

  // DingTalk mode: show loading while redirecting
  if (isAuthModeDingTalk()) {
    return (
      <div className="flex items-center justify-center h-screen bg-base">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
          <p className="mt-4 text-text-secondary">正在跳转...</p>
        </div>
      </div>
    )
  }

  // If user is already logged in, show loading while redirecting (useEffect will handle redirect)
  if (isLoggedIn) {
    return (
      <div className="flex items-center justify-center h-screen bg-base">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
          <p className="mt-4 text-text-secondary">正在跳转...</p>
        </div>
      </div>
    )
  }

  return (
    <main className="flex smart-h-screen flex-col items-center justify-center p-8 bg-base relative box-border">
      {/* Handle Aidesk authentication from 口袋 App - only rendered when not logged in */}
      <AideskTokenHandler />

      {/* Language Switcher */}
      <div className="absolute top-4 right-4 flex items-center gap-3">
        <GithubStarButton />
        <ThemeToggle />
        <LanguageSwitcher />
      </div>

      <div className="w-full max-w-2xl text-center">
        <h1 className="text-[30px]/9 md:text-[36px]/10 font-medium text-text-primary mb-4">
          <span className="font-bold">We</span>gent, more than an{' '}
          <span className="font-bold">A</span>gent.
        </h1>
        <p className="text-xl text-text-secondary mb-12 font-light">{t('extension.description')}</p>
        <Button onClick={handleGetStarted} variant="default">
          {t('actions.start')}
        </Button>
      </div>
      <PoweredByFooter />
    </main>
  )
}
