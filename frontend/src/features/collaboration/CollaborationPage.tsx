// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo } from 'react'
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
import { useTranslation } from '@/hooks/useTranslation'
import { createWebSharedWorkspaceApi } from '@/features/collaboration/shared-api'
import { webAutomationUiHost } from '@/features/collaboration/automation/WebAutomationHost'
import { collaborationLocationPath } from '@/features/collaboration/routes'

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
  const legacyProjectId =
    !workspaceRoute && segments[1] && segments[1] !== 'resources' && segments[1] !== 'my-work'
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
    platformView:
      pathname === '/collaboration/resources'
        ? 'resources'
        : pathname === '/collaboration/my-work'
          ? 'my-work'
          : 'spaces',
    workspaceId,
    workspaceView: workspaceViewFromPath(pathname),
    projectId,
    projectView,
    issueId,
  }

  useEffect(() => {
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
  }, [api, legacyIssueId, legacyProjectId, projectView, router])

  const platformHost = useMemo<CollaborationPlatformHostAdapter>(
    () => ({
      capabilities: {
        automation: true,
        dingtalkAitable: false,
        projectLocation: 'cloud',
        workspaceLocations: ['cloud'],
        sidebarPresentation: 'context',
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

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      <main className="min-w-0 flex-1 overflow-hidden" data-testid="collaboration-page-main">
        {legacyProjectId ? (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            正在进入协作空间…
          </div>
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
