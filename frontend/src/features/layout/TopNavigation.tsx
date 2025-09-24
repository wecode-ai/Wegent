// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { Button } from 'antd'

import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'

type TopNavigationProps = {
  activePage: 'tasks' | 'dashboard'
  showLogo?: boolean
  children?: React.ReactNode
}

export default function TopNavigation({ activePage, showLogo = false, children }: TopNavigationProps) {
  const { t } = useTranslation('common')
  const router = useRouter()

  const navigateToTasks = () => {
    router.push(paths.task.getHref())
  }

  const navigateToDashboard = () => {
    router.push(paths.settings.root.getHref())
  }

  return (
    <div className="relative flex items-center justify-center px-6 py-6">
      {showLogo && (
        <div className="absolute left-6 flex items-center">
          <Image
            src="/weibo-logo.png"
            alt="Weibo Logo"
            width={24}
            height={24}
            className="object-contain"
            priority
          />
        </div>
      )}

      <div className="flex items-center gap-6">
        <Button
          type="link"
          onClick={navigateToTasks}
          className={`!p-0 !h-auto !text-lg !font-medium ${
            activePage === 'tasks'
              ? '!text-text-primary'
              : '!text-text-secondary hover:!text-text-primary'
          }`}
        >
          {t('navigation.tasks')}
        </Button>
        <Button
          type="link"
          onClick={navigateToDashboard}
          className={`!p-0 !h-auto !text-lg !font-medium ${
            activePage === 'dashboard'
              ? '!text-text-primary'
              : '!text-text-secondary hover:!text-text-primary'
          }`}
        >
          {t('navigation.settings')}
        </Button>
      </div>

      {children && (
        <div className="absolute right-6 flex items-center gap-3">
          {children}
        </div>
      )}
    </div>
  )
}
