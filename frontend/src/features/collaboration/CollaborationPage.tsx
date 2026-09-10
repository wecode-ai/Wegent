// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import {
  CollaborationApp,
  createCollaborationApi,
  type CollaborationHostAdapter,
  type CollaborationLocale,
  type CollaborationView,
} from '@wegent/collaboration'
import { toast } from 'sonner'

import { apiClient } from '@/apis/client'
import { useTranslation } from '@/hooks/useTranslation'
import {
  CollapsedSidebarButtons,
  ResizableSidebar,
  TaskSidebar,
} from '@/features/tasks/components/sidebar'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'

import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

const COLLABORATION_VIEWS = new Set<CollaborationView>([
  'board',
  'files',
  'members',
  'automation',
  'runs',
  'manage',
])

export function CollaborationPage() {
  const router = useRouter()
  const params = useParams<{ projectId?: string; itemId?: string }>()
  const searchParams = useSearchParams()
  const { getCurrentLanguage } = useTranslation()
  const isMobile = useIsMobile()
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isCollapsed, setIsCollapsed] = useState(false)

  useEffect(() => {
    setIsCollapsed(localStorage.getItem('task-sidebar-collapsed') === 'true')
  }, [])

  const rawView = searchParams.get('view')
  const view: CollaborationView =
    rawView && COLLABORATION_VIEWS.has(rawView as CollaborationView)
      ? (rawView as CollaborationView)
      : 'board'
  const projectId = params.projectId ? decodeURIComponent(params.projectId) : null
  const issueId = params.itemId ? decodeURIComponent(params.itemId) : null
  const locale: CollaborationLocale = getCurrentLanguage().startsWith('zh') ? 'zh-CN' : 'en'

  const api = useMemo(() => createCollaborationApi(apiClient), [])
  const host = useMemo<CollaborationHostAdapter>(
    () => ({
      capabilities: {
        cloudProjects: true,
        localProjects: false,
        aiAssignment: true,
        automation: true,
        terminal: false,
        dingtalkAitable: false,
      },
      location: { projectId, issueId, view },
      navigate(location) {
        const nextView = location.view === 'board' ? '' : `?view=${location.view}`
        if (!location.projectId) {
          router.push('/collaboration')
        } else if (location.issueId) {
          router.push(
            `/collaboration/${encodeURIComponent(location.projectId)}/issues/${encodeURIComponent(location.issueId)}${nextView}`
          )
        } else {
          router.push(`/collaboration/${encodeURIComponent(location.projectId)}${nextView}`)
        }
      },
      openExternal(url) {
        window.open(url, '_blank', 'noopener,noreferrer')
      },
      notify(message, kind) {
        if (kind === 'success') toast.success(message)
        else toast.error(message)
      },
    }),
    [issueId, projectId, router, view]
  )

  const toggleCollapsed = () => {
    setIsCollapsed(current => {
      const next = !current
      localStorage.setItem('task-sidebar-collapsed', String(next))
      return next
    })
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {isCollapsed && !isMobile && (
        <CollapsedSidebarButtons
          onNewTask={() => router.push('/chat')}
          onExpand={toggleCollapsed}
        />
      )}
      <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={toggleCollapsed}>
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="collaboration"
          isCollapsed={isCollapsed}
          onToggleCollapsed={toggleCollapsed}
        />
      </ResizableSidebar>
      <main className="min-w-0 flex-1 overflow-auto">
        <CollaborationApp api={api} host={host} locale={locale} />
      </main>
    </div>
  )
}
