// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter } from 'next/navigation'
import { ChatBubbleLeftIcon, CodeBracketIcon, Cog6ToothIcon } from '@heroicons/react/24/outline'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'

interface MobileNavTabsProps {
  activePage: 'chat' | 'code' | 'dashboard'
}

export function MobileNavTabs({ activePage }: MobileNavTabsProps) {
  const router = useRouter()
  const { t } = useTranslation('common')

  const tabs = [
    { 
      key: 'chat' as const, 
      label: t('navigation.chat'),
      icon: ChatBubbleLeftIcon,
      path: paths.chat.getHref()
    },
    { 
      key: 'code' as const, 
      label: t('navigation.code'),
      icon: CodeBracketIcon,
      path: paths.code.getHref()
    },
    { 
      key: 'dashboard' as const, 
      label: t('navigation.settings'),
      icon: Cog6ToothIcon,
      path: paths.settings.root.getHref()
    }
  ]

  return (
    <div className="flex items-center bg-surface/50 backdrop-blur-sm rounded-full p-1 border border-border/50 shadow-sm">
      {tabs.map((tab) => {
        const Icon = tab.icon
        const isActive = activePage === tab.key
        
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => router.push(tab.path)}
            className={`
              flex items-center justify-center gap-1.5
              px-3 py-1.5 rounded-full text-sm font-medium
              transition-all duration-200
              ${isActive 
                ? 'bg-primary text-white shadow-sm' 
                : 'text-text-secondary hover:text-text-primary hover:bg-surface/80'
              }
            `}
            aria-label={tab.label}
            aria-current={isActive ? 'page' : undefined}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span className="hidden xs:inline">{tab.label}</span>
          </button>
        )
      })}
    </div>
  )
}