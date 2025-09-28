// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { Button } from 'antd'
import { Bars3Icon } from '@heroicons/react/24/outline'

import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'

type TopNavigationProps = {
  activePage: 'tasks' | 'dashboard'
  showLogo?: boolean
  children?: React.ReactNode
  onMobileSidebarToggle?: () => void
}

export default function TopNavigation({ activePage, showLogo = false, children, onMobileSidebarToggle }: TopNavigationProps) {
  const { t } = useTranslation('common')
  const router = useRouter()

  const navigateToTasks = () => {
    router.push(paths.task.getHref())
  }

  const navigateToDashboard = () => {
    router.push(`${paths.settings.root.getHref()}?tab=integrations`)
  }

  return (
    <div className="relative flex items-center justify-between px-4 sm:px-6 py-6 sm:py-8 min-h-[60px]">
      {/* Left side - Mobile sidebar toggle or Logo */}
      <div className="flex items-center">
        {onMobileSidebarToggle && (
          <button
            type="button"
            className="lg:hidden p-2 rounded-md text-text-muted hover:text-text-primary hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40 bg-surface border border-border"
            onClick={onMobileSidebarToggle}
          >
            <span className="sr-only">{t('common.open_sidebar')}</span>
            <Bars3Icon className="h-5 w-5" aria-hidden="true" />
          </button>
        )}

        {showLogo && !onMobileSidebarToggle && (
          <div className="flex items-center">
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
      </div>

      {/* Center - Navigation links - hide on mobile when sidebar toggle is present */}
      <div className={`flex items-center gap-3 sm:gap-6 ${onMobileSidebarToggle ? 'hidden lg:flex' : 'flex'}`}>
        <Button
          type="link"
          onClick={navigateToTasks}
          className={`!p-0 !h-auto !text-base sm:!text-lg !font-medium ${
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
          className={`!p-0 !h-auto !text-base sm:!text-lg !font-medium ${
            activePage === 'dashboard'
              ? '!text-text-primary'
              : '!text-text-secondary hover:!text-text-primary'
          }`}
        >
          {t('navigation.settings')}
        </Button>
      </div>

      {/* Right side - User menu and theme toggle */}
      {children && (
        <div className="flex items-center gap-2 sm:gap-3">
          {children}
        </div>
      )}
    </div>
  )
}
