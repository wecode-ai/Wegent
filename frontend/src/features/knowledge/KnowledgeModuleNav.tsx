// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { useTranslation } from '@/hooks/useTranslation'
import { CodeBracketIcon } from '@heroicons/react/24/outline'
import { UserFloatingMenu } from '@/features/layout/components/UserFloatingMenu'

export type KnowledgeModule = 'code' | 'wiki'

interface KnowledgeModuleNavProps {
  activeModule?: KnowledgeModule
}

interface ModuleItem {
  id: KnowledgeModule
  labelKey: string
  icon: React.ComponentType<{ className?: string }>
  href: string
  description?: string
}

const modules: ModuleItem[] = [
  {
    id: 'code',
    labelKey: 'knowledge:modules.code',
    icon: CodeBracketIcon,
    href: '/knowledge',
    description: 'knowledge:modules.code_desc',
  },
  // Future modules can be added here
  // {
  //   id: 'wiki',
  //   labelKey: 'modules.wiki',
  //   icon: BookOpenIcon,
  //   href: '/knowledge/wiki',
  //   description: 'modules.wiki_desc',
  // },
]

/**
 * Knowledge module navigation sidebar component
 * Displays navigation for different knowledge modules (Code Knowledge, Wiki, etc.)
 * Layout matches TaskSidebar with logo at top
 */
export function KnowledgeModuleNav({ activeModule }: KnowledgeModuleNavProps) {
  const { t } = useTranslation()
  const pathname = usePathname()

  // Determine active module from pathname if not provided
  const currentModule = activeModule || (pathname?.includes('/knowledge/wiki') ? 'wiki' : 'code')

  return (
    <div className="hidden lg:flex lg:flex-col w-56 border-r border-border bg-surface h-full">
      {/* Logo - matches TopNavigation height (min-h-[44px] with py-2 sm:py-3) */}
      <div className="px-3 py-2 sm:py-3 min-h-[44px] flex items-center">
        <div className="flex items-center gap-2">
          <Image
            src="/weibo-logo.png"
            alt="Weibo Logo"
            width={20}
            height={20}
            className="object-container"
          />
          <span className="text-sm text-text-primary">Wegent</span>
        </div>
      </div>

      {/* Module navigation */}
      <div className="px-2 flex-1">
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-4 px-2">
          {t('knowledge:modules.title')}
        </h2>
        <nav className="space-y-1">
          {modules.map(module => {
            const isActive = currentModule === module.id
            const Icon = module.icon

            return (
              <Link
                key={module.id}
                href={module.href}
                className={`
                  flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors
                  ${
                    isActive
                      ? 'bg-primary/10 text-primary border border-primary/20'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                  }
                `}
              >
                <Icon className={`w-5 h-5 flex-shrink-0 ${isActive ? 'text-primary' : ''}`} />
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium truncate">{t(module.labelKey)}</span>
                  {module.description && (
                    <span className="text-xs text-text-muted truncate">
                      {t(module.description)}
                    </span>
                  )}
                </div>
              </Link>
            )
          })}
        </nav>
      </div>

      {/* User Menu */}
      <div className="p-2 border-t border-border">
        <UserFloatingMenu />
      </div>
    </div>
  )
}
