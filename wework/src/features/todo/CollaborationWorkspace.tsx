// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from 'react'
import {
  CollaborationApp,
  type CollaborationHostAdapter,
  type CollaborationLocale,
  type CollaborationProject,
  type CollaborationView,
} from '@wegent/collaboration'
import '@wegent/collaboration/styles.css'

import { useTranslation } from '@/hooks/useTranslation'

import type { LocatedProjectSpace } from './projectSpaceSelection'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import {
  DesktopSidebarAccount,
  type DesktopSidebarAccountSettingsOptions,
} from '@/components/layout/DesktopSidebarAccount'
import type { User as UserProfile } from '@/types/api'
import {
  collaborationIssueId,
  collaborationProjectId,
  collaborationProjectReference,
  createWeworkCollaborationApi,
} from './weworkCollaborationApi'

function locatedProject(project: CollaborationProject): LocatedProjectSpace {
  const reference = collaborationProjectReference(project.id)
  return {
    ...project,
    id: reference.projectId,
    project_store: reference.location === 'local' ? 'local' : 'backend',
    location: reference.location,
  }
}

export interface CollaborationWorkspaceProps {
  activeProjectRef?: {
    projectId: string
    projectStore: 'local' | 'backend'
  } | null
  focusedItemId?: string | null
  onActiveProjectChange?: (project: LocatedProjectSpace | null) => void
  onFocusedItemHandled?: () => void
  startupActive?: boolean
  user: UserProfile
  onOpenSettings?: (options?: DesktopSidebarAccountSettingsOptions) => void
  onLogout?: () => void
  services: WorkbenchServices
}

interface SharedCollaborationWorkspaceProps extends CollaborationWorkspaceProps {
  api: ReturnType<typeof createWeworkCollaborationApi>
}

function SharedCollaborationWorkspace({
  activeProjectRef,
  api,
  focusedItemId,
  onActiveProjectChange,
  onFocusedItemHandled,
  onLogout,
  onOpenSettings,
  services,
  user,
}: SharedCollaborationWorkspaceProps) {
  const { i18n } = useTranslation('common')
  const hasLocalProjects = Boolean(services.projectSpaceApis?.local)
  const [view, setView] = useState<CollaborationView>('board')
  const [issueId, setIssueId] = useState<string | null>(() =>
    activeProjectRef?.projectStore === 'backend' && focusedItemId
      ? collaborationIssueId(
          { location: 'cloud', projectId: activeProjectRef.projectId },
          focusedItemId
        )
      : null
  )

  useEffect(() => {
    if (focusedItemId) onFocusedItemHandled?.()
  }, [focusedItemId, onFocusedItemHandled])

  const host = useMemo<CollaborationHostAdapter>(() => {
    const projectId = activeProjectRef
      ? collaborationProjectId({
          location: activeProjectRef.projectStore === 'local' ? 'local' : 'cloud',
          projectId: activeProjectRef.projectId,
        })
      : null
    return {
      capabilities: {
        cloudProjects: true,
        localProjects: hasLocalProjects,
        aiAssignment: false,
        automation: activeProjectRef?.projectStore !== 'local',
        terminal: true,
        dingtalkAitable: false,
      },
      location: { projectId, issueId, view },
      navigate(location) {
        setView(location.view)
        setIssueId(location.issueId)
        if (!location.projectId) {
          onActiveProjectChange?.(null)
          return
        }
        const reference = collaborationProjectReference(location.projectId)
        if (
          activeProjectRef?.projectId === reference.projectId &&
          activeProjectRef.projectStore === (reference.location === 'local' ? 'local' : 'backend')
        ) {
          return
        }
        void api.getProject(location.projectId).then(project => {
          onActiveProjectChange?.(locatedProject(project))
        })
      },
      openExternal(url) {
        window.open(url, '_blank', 'noopener,noreferrer')
      },
    }
  }, [activeProjectRef, api, hasLocalProjects, issueId, onActiveProjectChange, view])

  const locale: CollaborationLocale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
  return (
    <div className="flex h-full min-h-0" data-testid="wework-collaboration-workspace">
      {onOpenSettings && onLogout && (
        <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar p-2">
          <div className="flex-1" />
          <DesktopSidebarAccount user={user} onOpenSettings={onOpenSettings} onLogout={onLogout} />
        </aside>
      )}
      <div className="min-w-0 flex-1 overflow-auto bg-background text-text-primary">
        <CollaborationApp api={api} host={host} locale={locale} />
      </div>
    </div>
  )
}

export function CollaborationWorkspace(props: CollaborationWorkspaceProps) {
  const activeProjectRef = props.activeProjectRef ?? null
  const activeProjectKey = activeProjectRef
    ? `${activeProjectRef.projectStore}:${activeProjectRef.projectId}`
    : 'projects'
  const { collaborationApi, localProjectChatClient, projectSpaceApis, projectSpaceDetailServices } =
    props.services
  const api = useMemo(
    () =>
      createWeworkCollaborationApi({
        collaborationApi,
        localProjectChatClient,
        projectSpaceApis,
        projectSpaceDetailServices,
      }),
    [collaborationApi, localProjectChatClient, projectSpaceApis, projectSpaceDetailServices]
  )

  useEffect(() => {
    if (!props.startupActive || !isElectronRuntime() || getDesktopWindowLabel() !== 'main') {
      return
    }
    void invokeDesktopHost<void>('renderer.startupReady')
  }, [props.startupActive])

  return (
    <SharedCollaborationWorkspace
      key={`${activeProjectKey}:${props.focusedItemId ?? ''}`}
      activeProjectRef={activeProjectRef}
      api={api}
      focusedItemId={props.focusedItemId}
      onActiveProjectChange={props.onActiveProjectChange}
      onFocusedItemHandled={props.onFocusedItemHandled}
      onLogout={props.onLogout}
      onOpenSettings={props.onOpenSettings}
      services={props.services}
      user={props.user}
    />
  )
}
