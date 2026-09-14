// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  CollaborationPlatformApp,
  type CollaborationLocale,
  type CollaborationPlatformHostAdapter,
  type CollaborationPlatformLocation,
  type CollaborationView,
  type CollaborationWorkspaceView,
} from '@wegent/collaboration'
import { toast } from 'sonner'

import { apiClient } from '@/apis/client'
import TopNavigation from '@/features/layout/TopNavigation'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { useTranslation } from '@/hooks/useTranslation'
import { createWebSharedWorkspaceApi } from '@/features/collaboration/shared-api'
import { webProjectAgentConfigurationHost } from '@/features/collaboration/ProjectAgentConfigurationHost'
import { collaborationLocationPath } from '@/features/collaboration/routes'
import {
  CollapsedSidebarButtons,
  ResizableSidebar,
  TaskSidebar,
} from '@/features/tasks/components/sidebar'
import { useTaskSession } from '@/features/tasks/session/TaskSession'

import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

const PROJECT_VIEWS = new Set<CollaborationView>([
  'board',
  'table',
  'files',
  'automation',
  'manage',
])

function workspaceViewFromPath(pathname: string): CollaborationWorkspaceView {
  if (pathname.endsWith('/projects')) return 'projects'
  if (pathname.endsWith('/members')) return 'members'
  if (pathname.endsWith('/agents')) return 'agents'
  if (pathname.endsWith('/collaboration-groups')) return 'collaboration-groups'
  if (pathname.endsWith('/execution-environments')) return 'execution-environments'
  if (pathname.endsWith('/settings')) return 'settings'
  return 'home'
}

function CollaborationWebShell({ main, sidebar }: { main: ReactNode; sidebar: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const isMobile = useIsMobile()
  const { selectTask } = useTaskSession()
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isCollapsed, setIsCollapsed] = useState(false)

  useEffect(() => {
    setIsCollapsed(localStorage.getItem('task-sidebar-collapsed') === 'true')
  }, [])

  useEffect(() => {
    setIsMobileSidebarOpen(false)
  }, [pathname])

  const handleToggleCollapsed = () => {
    setIsCollapsed(current => {
      const next = !current
      localStorage.setItem('task-sidebar-collapsed', String(next))
      return next
    })
  }

  const handleNewTask = () => {
    selectTask(null)
    router.replace('/chat')
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border [--collaboration-primary-background:rgb(var(--color-primary))] [--collaboration-primary-foreground:rgb(var(--color-primary-contrast))]">
      {isCollapsed && !isMobile && (
        <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={handleNewTask} />
      )}
      <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="collaboration"
          isCollapsed={isCollapsed}
          onToggleCollapsed={handleToggleCollapsed}
          contextSection={sidebar}
        />
      </ResizableSidebar>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="lg:hidden">
          <TopNavigation
            variant="with-sidebar"
            onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
            isSidebarCollapsed={isCollapsed}
          />
        </div>
        <div
          className="min-h-0 min-w-0 flex-1 overflow-hidden"
          data-testid="collaboration-page-main"
        >
          {main}
        </div>
      </div>
    </div>
  )
}

export function CollaborationPage() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { getCurrentLanguage } = useTranslation()
  const api = useMemo(() => createWebSharedWorkspaceApi(apiClient), [])

  const segments = pathname.split('/').filter(Boolean)
  const workspaceRoute = segments[1] === 'workspaces'
  const workspaceId = workspaceRoute && segments[2] ? decodeURIComponent(segments[2]) : null
  const projectRoute = workspaceRoute && segments[3] === 'projects'
  const projectId = projectRoute && segments[4] ? decodeURIComponent(segments[4]) : null
  const issueId =
    projectRoute && segments[5] === 'issues' && segments[6] ? decodeURIComponent(segments[6]) : null
  const removedMyWorkRoute = pathname === '/collaboration/my-work'
  const removedResourcesRoute = pathname === '/collaboration/resources'
  const legacyProjectId =
    !workspaceRoute && segments[1] && segments[1] !== 'resources' && !removedMyWorkRoute
      ? decodeURIComponent(segments[1])
      : null
  const legacyIssueId =
    legacyProjectId && segments[2] === 'issues' && segments[3]
      ? decodeURIComponent(segments[3])
      : null
  const rawView = searchParams.get('view')
  const projectView: CollaborationView =
    rawView && PROJECT_VIEWS.has(rawView as CollaborationView)
      ? (rawView as CollaborationView)
      : 'board'
  const locale: CollaborationLocale = getCurrentLanguage().startsWith('zh') ? 'zh-CN' : 'en'
  useEffect(() => {
    if (removedMyWorkRoute || removedResourcesRoute) {
      router.replace('/collaboration')
      return
    }
    if (!legacyProjectId) return
    let active = true
    void api.projects
      .get(legacyProjectId)
      .then(project => {
        if (!active) return
        if (!project.workspace_id) {
          toast.error('该项目未关联协作空间')
          router.replace('/collaboration')
          return
        }
        router.replace(
          collaborationLocationPath({
            platformView: 'spaces',
            workspaceId: project.workspace_id,
            workspaceView: 'projects',
            projectId: project.id,
            projectView,
            issueId: legacyIssueId,
          })
        )
      })
      .catch(error => {
        if (!active) return
        toast.error(error instanceof Error ? error.message : '项目加载失败')
        router.replace('/collaboration')
      })
    return () => {
      active = false
    }
  }, [
    api,
    legacyIssueId,
    legacyProjectId,
    projectView,
    removedMyWorkRoute,
    removedResourcesRoute,
    router,
  ])

  const platformHost = useMemo<CollaborationPlatformHostAdapter>(
    () => ({
      capabilities: {
        automation: true,
        dingtalkAitable: false,
        projectLocation: 'cloud',
        workspaceLocations: ['cloud'],
        sidebarPresentation: 'context',
      },
      location: {
        platformView: 'spaces',
        workspaceId,
        workspaceView: workspaceViewFromPath(pathname),
        projectId,
        projectView,
        issueId,
      } satisfies CollaborationPlatformLocation,
      navigate(nextLocation) {
        const nextPath = collaborationLocationPath(nextLocation)
        const updatesCurrentIssueDrawer =
          Boolean(projectId) &&
          nextLocation.platformView === 'spaces' &&
          nextLocation.workspaceId === workspaceId &&
          nextLocation.projectId === projectId &&
          nextLocation.projectView === projectView &&
          nextLocation.issueId !== issueId
        if (updatesCurrentIssueDrawer) {
          window.history.pushState(null, '', nextPath)
          return
        }
        router.push(nextPath)
      },
      manageResource(kind, resourceId) {
        if (kind === 'agents') {
          router.push('/resource-library?tab=mine&type=agent&scope=personal')
          return
        }
        router.push(resourceId ? `/devices?deviceId=${encodeURIComponent(resourceId)}` : '/devices')
      },
      openExternal(url) {
        window.open(url, '_blank', 'noopener,noreferrer')
      },
      notify(message, kind) {
        if (kind === 'success') toast.success(message)
        else toast.error(message)
      },
      projectAgentConfiguration: webProjectAgentConfigurationHost,
    }),
    [issueId, pathname, projectId, projectView, router, workspaceId]
  )

  if (legacyProjectId) {
    return (
      <CollaborationWebShell
        sidebar={<div className="h-full" />}
        main={
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            正在进入协作空间…
          </div>
        }
      />
    )
  }

  return (
    <CollaborationPlatformApp
      api={api}
      host={platformHost}
      locale={locale}
      renderShell={({ main, sidebar }) => <CollaborationWebShell main={main} sidebar={sidebar} />}
    />
  )
}
