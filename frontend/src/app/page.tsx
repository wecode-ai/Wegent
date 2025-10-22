// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter } from 'next/navigation'
import { Button } from 'antd'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'
import LanguageSwitcher from '@/components/LanguageSwitcher'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { getToken } from '@/apis/user'

export default function Home() {
  const router = useRouter()
  const { t } = useTranslation('common')
  
  const handleGetStarted = () => {
    const token = getToken()
    if (token) {
      router.replace(paths.task.getHref())
    } else {
      router.push(paths.auth.login.getHref())
    }
  }

  return (
    <main className="flex smart-h-screen flex-col items-center justify-center p-8 bg-base relative box-border">
      {/* Language Switcher */}
      <div className="absolute top-4 right-4 flex items-center gap-3">
        <ThemeToggle />
        <LanguageSwitcher />
      </div>
      
      <div className="w-full max-w-2xl text-center">
        <h1 className="text-5xl font-medium text-text-primary mb-4">
          {t('extension.name')}
        </h1>
        <p className="text-xl text-text-secondary mb-12 font-light">
          {t('extension.description')}
        </p>
        <Button
          onClick={handleGetStarted}
          type="primary"
          size="middle"
        >
          {t('actions.start')}
        </Button>
      </div>
    </main>
  )
}
