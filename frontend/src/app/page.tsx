// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { paths } from '@/config/paths'
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

  // DingTalk mode: skip landing page, go directly to auth
  useEffect(() => {
    if (isAuthModeDingTalk()) {
      router.replace('/auth/dingtalk')
    }
  }, [router])

  // Listen for Aidesk login success event and redirect to chat
  useEffect(() => {
    const handleAideskLoginSuccess = () => {
      router.replace(paths.chat.getHref())
    }

    window.addEventListener('aidesk-login-success', handleAideskLoginSuccess)
    return () => {
      window.removeEventListener('aidesk-login-success', handleAideskLoginSuccess)
    }
  }, [router])

  const handleGetStarted = () => {
    const token = getToken()
    if (token) {
      // Try to restore user's last active tab
      const lastTab = getLastTab()
      if (lastTab === 'code') {
        router.replace(paths.code.getHref())
      } else if (lastTab === 'wiki') {
        router.replace(paths.wiki.getHref())
      } else {
        // Default to chat if no preference or preference is chat
        router.replace(paths.chat.getHref())
      }
    } else {
      router.push(paths.auth.login.getHref())
    }
  }

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

  return (
    <main className="flex smart-h-screen flex-col items-center justify-center p-8 bg-base relative box-border">
      {/* Handle Aidesk authentication from 口袋 App */}
      <AideskTokenHandler />

      {/* Language Switcher */}
      <div className="absolute top-4 right-4 flex items-center gap-3">
        <GithubStarButton />
        <ThemeToggle />
        <LanguageSwitcher />
      </div>

      <div className="w-full max-w-2xl text-center">
        <h1 className="text-5xl font-medium text-text-primary mb-4">
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
