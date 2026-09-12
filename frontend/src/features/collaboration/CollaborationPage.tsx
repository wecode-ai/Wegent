// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  CollaborationApp,
  CollaborationPlatformApp,
  type CollaborationHostAdapter,
  type CollaborationLocale,
  type CollaborationPlatformHostAdapter,
  type CollaborationPlatformLocation,
  type CollaborationProject,
  type CollaborationView,
  type CollaborationWorkspaceView,
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
import { createWebSharedWorkspaceApi } from '@/features/collaboration/shared-api'
import { webAutomationUiHost } from '@/features/collaboration/automation/WebAutomationHost'
import { CollaborationProjectSection } from './CollaborationProjectSection'

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
  if (pathname.endsWith('/execution-environments')) return 'execution-environments'
  if (pathname.endsWith('/settings')) return 'settings'
  return 'home'
}

export function collaborationLocationPath(location: CollaborationPlatformLocation): string {
  if (!location.workspaceId) {
    return location.platformView === 'resources' ? '/collaboration/resources' : '/collaboration'
  }
  const workspaceBase = `/collaboration/workspaces/${encodeURIComponent(location.workspaceId)}`
  if (!location.projectId) {
    const suffix: Record<CollaborationWorkspaceView, string> = {
      home: '',
      projects: '/projects',
      members: '/members',
      agents: '/agents',
      'execution-environments': '/execution-environments',
      settings: '/settings',
    }
    return `${workspaceBase}${suffix[location.workspaceView]}`
  }
  const projectBase = `${workspaceBase}/projects/${encodeURIComponent(location.projectId)}`
  const query = location.projectView === 'board' ? '' : `?view=${location.projectView}`
  return location.issueId
    ? `${projectBase}/issues/${encodeURIComponent(location.issueId)}${query}`
    : `${projectBase}${query}`
}

export function CollaborationPage() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { getCurrentLanguage } = useTranslation()
  const isMobile = useIsMobile()
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [collaborationProjects, setCollaborationProjects] = useState<CollaborationProject[]>([])
  const [createProjectRequestKey, setCreateProjectRequestKey] = useState(0)
  const api = useMemo(() => createWebSharedWorkspaceApi(apiClient), [])

  useEffect(() => {
    setIsCollapsed(localStorage.getItem('task-sidebar-collapsed') === 'true')
  }, [])

  const segments = pathname.split('/').filter(Boolean)
  const workspaceRoute = segments[1] === 'workspaces'
  const workspaceId = workspaceRoute && segments[2] ? decodeURIComponent(segments[2]) : null
  const projectRoute = workspaceRoute && segments[3] === 'projects'
  const projectId = projectRoute && segments[4] ? decodeURIComponent(segments[4]) : null
  const issueId =
    projectRoute && segments[5] === 'issues' && segments[6] ? decodeURIComponent(segments[6]) : null
  const legacyProjectId =
    !workspaceRoute && segments[1] && segments[1] !== 'resources'
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
  const location: CollaborationPlatformLocation = {
    platformView: pathname === '/collaboration/resources' ? 'resources' : 'spaces',
    workspaceId,
    workspaceView: workspaceViewFromPath(pathname),
    projectId,
    projectView,
    issueId,
  }

  const platformHost = useMemo<CollaborationPlatformHostAdapter>(
    () => ({
      capabilities: {
        automation: true,
        dingtalkAitable: false,
      },
      location,
      navigate(nextLocation) {
        router.push(collaborationLocationPath(nextLocation))
      },
      openExternal(url) {
        window.open(url, '_blank', 'noopener,noreferrer')
      },
      notify(message, kind) {
        if (kind === 'success') toast.success(message)
        else toast.error(message)
      },
    }),
    [location, router]
  )
  const projectHost = useMemo<CollaborationHostAdapter>(
    () => ({
      capabilities: {
        myWork: false,
        automation: true,
        dingtalkAitable: false,
      },
      location: {
        projectId: legacyProjectId,
        issueId: legacyIssueId,
        view: projectView,
        rootView: 'home',
      },
      onProjectsChange: setCollaborationProjects,
      navigate(nextLocation) {
        const query = nextLocation.view === 'board' ? '' : `?view=${nextLocation.view}`
        if (!nextLocation.projectId) {
          router.push('/collaboration')
        } else if (nextLocation.issueId) {
          router.push(
            `/collaboration/${encodeURIComponent(nextLocation.projectId)}/issues/${encodeURIComponent(nextLocation.issueId)}${query}`
          )
        } else {
          router.push(`/collaboration/${encodeURIComponent(nextLocation.projectId)}${query}`)
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
    [legacyIssueId, legacyProjectId, projectView, router]
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
          projectSection={
            legacyProjectId ? (
              <CollaborationProjectSection
                locale={locale}
                onAdd={() => setCreateProjectRequestKey(current => current + 1)}
                onSelect={nextProjectId =>
                  router.push(`/collaboration/${encodeURIComponent(nextProjectId)}`)
                }
                projects={collaborationProjects}
                selectedProjectId={legacyProjectId}
              />
            ) : undefined
          }
        />
      </ResizableSidebar>
      <main className={`min-w-0 flex-1 ${legacyProjectId ? 'overflow-auto' : 'overflow-hidden'}`}>
        {legacyProjectId ? (
          <CollaborationApp
            api={api}
            host={projectHost}
            locale={locale}
            automationUiHost={webAutomationUiHost}
            createProjectRequestKey={createProjectRequestKey}
          />
        ) : (
          <CollaborationPlatformApp
            api={api}
            host={platformHost}
            locale={locale}
            automationUiHost={webAutomationUiHost}
          />
        )}
      </main>
    </div>
  )
}
