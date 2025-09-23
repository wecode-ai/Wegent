// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter } from 'next/navigation'
import { Button } from 'antd'
import { useUser } from '@/features/common/UserContext'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'
import LanguageSwitcher from '@/components/LanguageSwitcher'

export default function Home() {
  const router = useRouter()
  const { t } = useTranslation('common')
  const { user } = useUser()
  
  const handleGetStarted = () => {
    if (user) {
      router.replace(paths.task.getHref())
    } else {
      router.push(paths.auth.login.getHref())
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8 bg-[#0d1117] relative">
      {/* 语言切换器 */}
      <div className="absolute top-4 right-4">
        <LanguageSwitcher />
      </div>
      
      <div className="w-full max-w-2xl text-center">
        <h1 className="text-5xl font-medium text-white mb-4">
          {t('extension.name')}
        </h1>
        <p className="text-xl text-gray-400 mb-12 font-light">
          {t('extension.description')}
        </p>
        <Button
          onClick={handleGetStarted}
          type="primary"
          size="middle"
        >
          {user ? t('navigation.dashboard') : t('actions.start')}
        </Button>
      </div>
    </main>
  )
}