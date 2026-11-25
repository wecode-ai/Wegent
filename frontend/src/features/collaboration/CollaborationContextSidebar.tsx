// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { UserFloatingMenu } from '@/features/layout/components/UserFloatingMenu'
import { useTranslation } from '@/hooks/useTranslation'

export function CollaborationContextSidebar({
  workspaceTree,
  mobile = false,
}: {
  workspaceTree: ReactNode
  mobile?: boolean
}) {
  const { t } = useTranslation('common')
  const router = useRouter()

  return (
    <aside
      className={`collaboration-platform-sidebar-surface flex h-full min-h-0 flex-col text-text-primary ${mobile ? 'w-64 max-w-[85vw]' : 'w-full'}`}
      data-testid="collaboration-context-sidebar"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mx-2 mt-2 min-h-11 shrink-0 justify-start gap-2 px-2 lg:min-h-8"
        data-testid="collaboration-back-to-workbench"
        onClick={() => router.push('/chat')}
      >
        <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        {t('collaboration_sidebar.back_to_workbench')}
      </Button>
      <div className="min-h-0 flex-1 overflow-hidden [&>.collaboration-platform-sidebar]:h-full [&>.collaboration-platform-sidebar]:w-full">
        {workspaceTree}
      </div>
      <div className="shrink-0 border-t border-border-light px-2.5 py-3">
        <UserFloatingMenu />
      </div>
    </aside>
  )
}
