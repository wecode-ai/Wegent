// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { createBrowserRuntimeDeviceAccess } from './runtimeDeviceAccess'
import type { InstalledPlugin } from '@wegent/chat-core/installed-plugin-types'

import { deviceApis } from '@/apis/devices'

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
import { CollaborationTheme, useDocumentTheme } from '@wegent/collaboration/theme'

import {
  createProjectChatClient,
  createCloudRuntimeIpcClient,
  createRuntimeConversationClient,
} from '@wegent/chat-core'
import { getToken } from '@/apis/user'
import { fetchRuntimeConfig, getSocketUrl } from '@/lib/runtime-config'

import { ApiError, apiClient } from '@/apis/client'
import { toAttachmentResponse } from '@wegent/chat-core/attachment-response'
import { listRuntimeModels } from './runtimeModels'
import { createRuntimeComposerApi } from '@wegent/chat-core/runtime-composer-api'
import { createWebComposerQuickPhrases } from './composerQuickPhrases'
import { paths } from '@/config/paths'
import { uploadAttachment, deleteAttachment, fetchAttachmentFile } from '@/apis/attachments'
import { readRuntimeWorkspaceFile } from './runtimeWorkspaceFiles'
import { createRuntimeConversationApi } from '@wegent/chat-core/runtime-conversation-api'
import { listGroups } from '@/apis/groups'
import TopNavigation from '@/features/layout/TopNavigation'
import { useTranslation } from '@/hooks/useTranslation'
import { CollaborationContextSidebar } from '@/features/collaboration/CollaborationContextSidebar'
import { createWebSharedWorkspaceApi } from '@/features/collaboration/shared-api'
import { webProjectAgentConfigurationHost } from '@/features/collaboration/ProjectAgentConfigurationHost'
import { useUser } from '@/features/common/UserContext'
import {
  collaborationLocationPath,
  collaborationRootViewForPath,
} from '@/features/collaboration/routes'
import { ResizableSidebar } from '@/features/tasks/components/sidebar'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

const PROJECT_VIEWS = new Set<CollaborationView>(['board', 'table', 'files', 'manage'])

function workspaceViewFromPath(pathname: string): CollaborationWorkspaceView {
  if (pathname.endsWith('/projects')) return 'projects'
  if (pathname.endsWith('/members')) return 'members'
  if (pathname.endsWith('/agents')) return 'agents'
  if (pathname.endsWith('/participants')) return 'collaboration-participants'
  if (pathname.endsWith('/collaboration-groups')) return 'collaboration-groups'
  if (pathname.endsWith('/execution-environments')) return 'execution-environments'
  if (pathname.endsWith('/settings')) return 'settings'
  return 'home'
}

function CollaborationWebShell({ main, sidebar }: { main: ReactNode; sidebar: ReactNode }) {
  const pathname = usePathname()
  const { t } = useTranslation('common')
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  useEffect(() => {
    setIsMobileSidebarOpen(false)
  }, [pathname])

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      <ResizableSidebar
        minWidth={220}
        maxWidth={360}
        defaultWidth={244}
        storageKey="collaboration-sidebar-width"
      >
        <CollaborationContextSidebar workspaceTree={sidebar} />
      </ResizableSidebar>
      {isMobileSidebarOpen ? (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/30"
            aria-label={t('collaboration_sidebar.close_navigation')}
            onClick={() => setIsMobileSidebarOpen(false)}
          />
          <div className="relative h-full">
            <CollaborationContextSidebar
              workspaceTree={sidebar}
              mobile
              onNavigate={() => setIsMobileSidebarOpen(false)}
            />
          </div>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="lg:hidden">
          <TopNavigation
            variant="with-sidebar"
            onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
            isSidebarCollapsed={false}
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
  const theme = useDocumentTheme()
  const { user } = useUser()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { getCurrentLanguage } = useTranslation()
  const api = useMemo(() => {
    const socketOptions = {
      socketBaseUrl: async () => {
        const config = await fetchRuntimeConfig()
        return config.socketDirectUrl || getSocketUrl()
      },
      socketPath: '/socket.io',
      getToken,
      clientOrigin: 'web' as const,
    }
    const ipc = createCloudRuntimeIpcClient(socketOptions)
    return {
      ...createWebSharedWorkspaceApi(apiClient),
      activity: createProjectChatClient(socketOptions),
      runtime: {
        checkDeviceAccess: createBrowserRuntimeDeviceAccess(
          async () => (await deviceApis.getAllDevices()).items
        ),
        quickPhrases: createWebComposerQuickPhrases(apiClient),
        composer: createRuntimeComposerApi(
          ipc,
          async deviceId =>
            (
              await apiClient.get<{ items: InstalledPlugin[] }>(
                `/plugins/installed?device_id=${encodeURIComponent(deviceId)}`
              )
            ).items
        ),
        work: createRuntimeConversationApi(apiClient),
        executeCommand: deviceApis.executeCommand,
        fileChangesFromError: (cause: unknown) => {
          if (!(cause instanceof ApiError) || typeof cause.detail !== 'object' || !cause.detail)
            return undefined
          return (cause.detail as Record<string, unknown>).file_changes
        },
        ...createRuntimeConversationClient(ipc),
        listDevices: async () => (await deviceApis.getAllDevices()).items,
        listModels: (deviceId: string) => listRuntimeModels(ipc, deviceId),
        uploadAttachment: async (file: File, onProgress?: (progress: number) => void) =>
          toAttachmentResponse(await uploadAttachment(file, onProgress), file),
        deleteAttachment,
        openModelSettings: () =>
          window.open(paths.settings.models.getHref(), '_blank', 'noopener,noreferrer'),
        readAttachment: fetchAttachmentFile,
        readWorkspaceFile: readRuntimeWorkspaceFile,
      },
    }
  }, [])
  useEffect(
    () => () => {
      api.activity.dispose()
      api.runtime.dispose()
    },
    [api]
  )
  const locale: CollaborationLocale = getCurrentLanguage().startsWith('zh') ? 'zh-CN' : 'en'
  const personalOwnerLabel = locale === 'zh-CN' ? '个人' : 'Personal'
  const [workspaceOwnerOptions, setWorkspaceOwnerOptions] = useState([
    { label: personalOwnerLabel, namespace: 'default' },
  ])

  useEffect(() => {
    let active = true
    void listGroups({ page: 1, limit: 100 })
      .then(response => {
        if (!active) return
        setWorkspaceOwnerOptions([
          { label: personalOwnerLabel, namespace: 'default' },
          ...response.items
            .filter(group => ['Owner', 'Maintainer', 'Developer'].includes(group.my_role ?? ''))
            .map(group => ({
              label: group.display_name || group.name,
              namespace: group.name,
            })),
        ])
      })
      .catch(() => {
        if (active) {
          setWorkspaceOwnerOptions([{ label: personalOwnerLabel, namespace: 'default' }])
        }
      })
    return () => {
      active = false
    }
  }, [personalOwnerLabel])

  const segments = pathname.split('/').filter(Boolean)
  const workspaceRoute = segments[1] === 'workspaces'
  const workspaceId = workspaceRoute && segments[2] ? decodeURIComponent(segments[2]) : null
  const projectRoute = workspaceRoute && segments[3] === 'projects'
  const projectId = projectRoute && segments[4] ? decodeURIComponent(segments[4]) : null
  const issueId =
    projectRoute && segments[5] === 'issues' && segments[6] ? decodeURIComponent(segments[6]) : null
  const removedResourcesRoute = pathname === '/collaboration/resources'
  const parsedRootView = collaborationRootViewForPath(pathname)
  const rootView = parsedRootView ?? 'home'
  const legacyProjectId =
    !workspaceRoute && segments[1] && !parsedRootView && segments[1] !== 'resources'
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
  useEffect(() => {
    if (
      !projectRoute ||
      !workspaceId ||
      !projectId ||
      !rawView ||
      PROJECT_VIEWS.has(rawView as CollaborationView)
    ) {
      return
    }
    router.replace(
      collaborationLocationPath({
        platformView: 'spaces',
        workspaceId,
        workspaceView: 'projects',
        projectId,
        projectView: 'board',
        issueId,
      })
    )
  }, [issueId, projectId, projectRoute, rawView, router, workspaceId])
  useEffect(() => {
    if (removedResourcesRoute) {
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
  }, [api, legacyIssueId, legacyProjectId, projectView, removedResourcesRoute, router])

  const platformHost = useMemo<CollaborationPlatformHostAdapter>(
    () => ({
      ...(user
        ? {
            currentUser: {
              id: user.id,
              name: user.user_name,
            },
          }
        : {}),
      capabilities: {
        automation: true,
        dingtalkAitable: false,
        projectLocation: 'cloud',
        workspaceLocations: ['cloud'],
        sidebarPresentation: 'context',
      },
      location: {
        platformView: 'spaces',
        rootView,
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
          router.push('/resource-library?tab=mine&type=agent&scope=personal&action=create-agent')
          return
        }
        router.push(
          resourceId ? `/devices?deviceId=${encodeURIComponent(resourceId)}` : '/devices?register=1'
        )
      },
      openExternal(url) {
        window.open(url, '_blank', 'noopener,noreferrer')
      },
      notify(message, kind) {
        if (kind === 'success') toast.success(message)
        else toast.error(message)
      },
      workspaceOwnerOptions,
      projectAgentConfiguration: webProjectAgentConfigurationHost,
    }),
    [
      issueId,
      pathname,
      projectId,
      projectView,
      rootView,
      router,
      user,
      workspaceId,
      workspaceOwnerOptions,
    ]
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
    <CollaborationTheme mode={theme}>
      <CollaborationPlatformApp
        api={api}
        host={platformHost}
        locale={locale}
        renderShell={({ main, sidebar }) => <CollaborationWebShell main={main} sidebar={sidebar} />}
      />
    </CollaborationTheme>
  )
}
