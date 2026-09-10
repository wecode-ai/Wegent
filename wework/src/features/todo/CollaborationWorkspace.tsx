// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { MonitorCog } from 'lucide-react'
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

import { CloudTodoWorkspace, type CloudTodoWorkspaceProps } from './CloudTodoWorkspace'
import type { LocatedProjectSpace } from './projectSpaceSelection'
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

interface SharedCollaborationWorkspaceProps extends Pick<
  CloudTodoWorkspaceProps,
  | 'activeProjectRef'
  | 'focusedItemId'
  | 'onActiveProjectChange'
  | 'onFocusedItemHandled'
  | 'services'
> {
  api: ReturnType<typeof createWeworkCollaborationApi>
  onOpenDesktopWorkspace(): void
}

function SharedCollaborationWorkspace({
  activeProjectRef,
  api,
  focusedItemId,
  onActiveProjectChange,
  onFocusedItemHandled,
  onOpenDesktopWorkspace,
  services,
}: SharedCollaborationWorkspaceProps) {
  const { i18n } = useTranslation('common')
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
        localProjects: Boolean(services.projectSpaceApis?.local),
        aiAssignment: false,
        automation: true,
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
      projectActions: activeProjectRef
        ? [
            {
              id: 'desktop-workspace',
              label: i18n.language.startsWith('zh') ? '桌面能力' : 'Desktop tools',
              testId: 'collaboration-open-desktop-workspace',
              renderIcon: () => <MonitorCog size={16} />,
              invoke: onOpenDesktopWorkspace,
            },
          ]
        : undefined,
    }
  }, [
    activeProjectRef,
    api,
    i18n.language,
    issueId,
    onActiveProjectChange,
    onOpenDesktopWorkspace,
    services.projectSpaceApis?.local,
    view,
  ])

  const locale: CollaborationLocale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
  return (
    <div
      className="h-full min-h-0 overflow-auto bg-background text-text-primary"
      data-testid="wework-collaboration-workspace"
    >
      <CollaborationApp api={api} host={host} locale={locale} />
    </div>
  )
}

export function CollaborationWorkspace(props: CloudTodoWorkspaceProps) {
  const activeProjectRef = props.activeProjectRef ?? null
  const activeProjectKey = activeProjectRef
    ? `${activeProjectRef.projectStore}:${activeProjectRef.projectId}`
    : 'projects'
  const [desktopProjectKey, setDesktopProjectKey] = useState<string | null>(null)
  const collaborationAvailable = Boolean(props.services.collaborationApi)
  const api = useMemo(
    () => (collaborationAvailable ? createWeworkCollaborationApi(props.services) : null),
    [collaborationAvailable, props.services]
  )
  const useDesktopWorkspace = !api || desktopProjectKey === activeProjectKey

  if (useDesktopWorkspace) return <CloudTodoWorkspace {...props} />

  return (
    <SharedCollaborationWorkspace
      key={`${activeProjectKey}:${props.focusedItemId ?? ''}`}
      activeProjectRef={activeProjectRef}
      api={api}
      focusedItemId={props.focusedItemId}
      onActiveProjectChange={props.onActiveProjectChange}
      onFocusedItemHandled={props.onFocusedItemHandled}
      onOpenDesktopWorkspace={() => setDesktopProjectKey(activeProjectKey)}
      services={props.services}
    />
  )
}
