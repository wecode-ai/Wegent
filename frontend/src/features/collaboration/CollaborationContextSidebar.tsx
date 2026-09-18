// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { ReactNode } from 'react'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { Activity, ArrowLeft, House, Inbox, UserRound } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { UserFloatingMenu } from '@/features/layout/components/UserFloatingMenu'
import { useTranslation } from '@/hooks/useTranslation'

const navigation = [
  {
    href: '/collaboration',
    labelKey: 'collaboration_sidebar.home',
    icon: House,
    testId: 'collaboration-nav-home',
  },
  {
    href: '/collaboration/my-work',
    labelKey: 'collaboration_sidebar.my_work',
    icon: UserRound,
    testId: 'collaboration-nav-my-work',
  },
  {
    href: '/collaboration/inbox',
    labelKey: 'collaboration_sidebar.inbox',
    icon: Inbox,
    testId: 'collaboration-nav-inbox',
  },
  {
    href: '/collaboration/runs',
    labelKey: 'collaboration_sidebar.run_center',
    icon: Activity,
    testId: 'collaboration-nav-runs',
  },
] as const

export function CollaborationContextSidebar({
  workspaceTree,
  mobile = false,
  onNavigate,
}: {
  workspaceTree: ReactNode
  mobile?: boolean
  onNavigate?(): void
}) {
  const pathname = usePathname()
  const router = useRouter()
  const { t } = useTranslation('common')

  const navigate = (href: string) => {
    router.push(href)
    onNavigate?.()
  }

  return (
    <aside
      className={`flex min-h-0 flex-col bg-base font-sans text-base text-text-primary ${
        mobile
          ? 'h-full w-[244px] max-w-[85vw]'
          : 'my-2 h-[calc(100%-24px)] w-full rounded-3xl shadow-sidebar'
      }`}
      data-testid="collaboration-context-sidebar"
    >
      <div className="shrink-0">
        <div className="flex items-center gap-2 px-5 pb-1.5 pt-2">
          <Image
            src="/weibo-logo.png"
            alt="Weibo Logo"
            width={36}
            height={35}
            className="object-contain"
            priority
            unoptimized
          />
          <span className="text-base font-semibold text-text-primary">Wegent</span>
        </div>
        <div className="px-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-11 min-w-[44px] w-full justify-start rounded-md px-3 text-sm text-text-primary transition-all duration-200 hover:bg-[rgb(238,238,238)] dark:hover:bg-white/10 lg:h-8"
            data-testid="collaboration-back-to-workbench"
            onClick={() => navigate('/chat')}
          >
            <span className="flex min-w-0 flex-1 items-center justify-start gap-2.5 text-left">
              <ArrowLeft className="h-4 w-4 flex-shrink-0" />
              <span className="min-w-0 truncate text-[14px] font-medium leading-5">
                {t('collaboration_sidebar.back_to_workbench')}
              </span>
            </span>
          </Button>
        </div>
        <div className="px-5 pb-1 pt-3 text-xs font-medium text-text-muted">
          {t('collaboration_sidebar.title')}
        </div>
        <nav className="grid gap-0.5 px-2.5" aria-label={t('collaboration_sidebar.aria_label')}>
          {navigation.map(item => {
            const active =
              item.href === '/collaboration'
                ? pathname === item.href
                : pathname.startsWith(item.href)
            const Icon = item.icon
            return (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={`h-11 min-w-[44px] w-full justify-start rounded-md px-3 text-sm transition-all duration-200 lg:h-8 ${
                  active
                    ? 'bg-primary/10 text-primary font-medium hover:bg-primary/15'
                    : 'text-text-primary hover:bg-[rgb(238,238,238)] dark:hover:bg-white/10'
                }`}
                aria-current={active ? 'page' : undefined}
                data-testid={item.testId}
                key={item.href}
                onClick={() => navigate(item.href)}
              >
                <span className="flex min-w-0 flex-1 items-center justify-start gap-2.5 text-left">
                  <Icon className="h-4 w-4 flex-shrink-0" />
                  <span className="min-w-0 truncate text-[14px] font-medium leading-5">
                    {t(item.labelKey)}
                  </span>
                </span>
              </Button>
            )
          })}
        </nav>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-2.5 pt-1 [&>.collaboration-platform-sidebar]:h-full [&>.collaboration-platform-sidebar]:border-r-0 [&>.collaboration-platform-sidebar]:bg-transparent [&>.collaboration-platform-sidebar]:p-0">
        {workspaceTree}
      </div>
      <div className="shrink-0 border-t border-border-light px-2.5 py-3">
        <UserFloatingMenu />
      </div>
    </aside>
  )
}
