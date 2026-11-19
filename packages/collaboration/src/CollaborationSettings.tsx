import { useDialogRequests } from './controls/useDialogRequests'
import { ActionMenu } from './controls/ActionMenu'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo, type ComponentType, type SVGProps } from 'react'

import type { CollaborationTranslate } from './i18n'
import type { SharedWorkspaceApi } from './ports/SharedWorkspaceApi'
import {
  ProjectAgentConfiguration,
  type ProjectAgentConfigurationHost,
} from './project-agent-config'
import {
  createSharedWorkspaceProjectManageApi,
  ProjectManageView,
  type ProjectManageHost,
} from './project-manage'
import type { CollaborationProject } from './types'

interface CollaborationSettingsProps {
  api: SharedWorkspaceApi
  project: CollaborationProject
  onChange(project: CollaborationProject): void
  onError(): void
  onAgentsChange?(): void
  agentConfigurationHost?: ProjectAgentConfigurationHost
  agentResourceContext?: {
    name: string
    namespace: string
  }
  embedded?: boolean
  translate: CollaborationTranslate
  section?: 'overview' | 'members' | 'agents' | 'board'
  quickAddRequest?: {
    id: number
    target: 'members' | 'agents'
  }
  onQuickAddRequestConsumed?(requestId: number): void
}

function createManageIcon(paths: string[]): ComponentType<SVGProps<SVGSVGElement>> {
  return function ManageIcon({ className }) {
    return (
      <svg
        aria-hidden="true"
        className={className}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth="2"
      >
        {paths.map(path => (
          <path d={path} key={path} />
        ))}
      </svg>
    )
  }
}

const manageIcons: ProjectManageHost['icons'] = {
  Check: createManageIcon(['M5 12l4 4L19 7']),
  GitBranch: createManageIcon(['M6 3v12', 'M18 9V3', 'M6 9h8a4 4 0 0 0 4-4']),
  LockKeyhole: createManageIcon(['M7 10V7a5 5 0 0 1 10 0v3', 'M5 10h14v11H5z', 'M12 14v3']),
  Pencil: createManageIcon(['M4 20l4-1 11-11-3-3L5 16z', 'M14 7l3 3']),
  Search: createManageIcon(['M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14', 'M16 16l5 5']),
  Trash2: createManageIcon(['M4 7h16', 'M9 7V4h6v3', 'M7 7l1 14h8l1-14']),
  X: createManageIcon(['M6 6l12 12', 'M18 6L6 18']),
}

export function CollaborationSettings({
  api,
  project,
  onChange,
  onError,
  onAgentsChange,
  agentConfigurationHost,
  agentResourceContext,
  embedded = false,
  translate,
  section = 'overview',
  quickAddRequest,
  onQuickAddRequestConsumed,
}: CollaborationSettingsProps) {
  const { confirm: requestConfirmation, dialogs: requestDialogs } = useDialogRequests(
    (key, fallback) => translate(key, fallback)
  )

  const manageApi = useMemo(() => createSharedWorkspaceProjectManageApi(api), [api])

  const host = useMemo<ProjectManageHost>(
    () => ({
      icons: manageIcons,
      translate,
      confirm: message => requestConfirmation(message),
      trackCompleted: () => undefined,
      trackFailed: onError,
      renderTooltip: ({ label, children }) => <span title={label}>{children}</span>,
      renderActionMenu: ({ ariaLabel, testId, triggerClassName, density, items }) => (
        <ActionMenu
          ariaLabel={ariaLabel}
          testId={testId}
          density={density}
          triggerClassName={triggerClassName}
          items={items.map(item => ({
            ...item,
            icon: item.icon as ComponentType<{ className?: string }>,
          }))}
        />
      ),
    }),
    [onError, translate, requestConfirmation]
  )

  return (
    <>
      {' '}
      {requestDialogs}{' '}
      <ProjectManageView
        api={manageApi}
        embedded={embedded}
        host={host}
        project={project}
        section={section}
        onProjectUpdated={onChange}
        openMembersRequestId={
          section === 'members' && quickAddRequest?.target === 'members'
            ? quickAddRequest.id
            : undefined
        }
        onOpenMembersRequestConsumed={onQuickAddRequestConsumed}
        renderProviderSettings={() => (
          <ProjectAgentConfiguration
            api={api}
            host={agentConfigurationHost}
            project={project}
            resourceContext={agentResourceContext}
            onError={onError}
            onAgentsChange={onAgentsChange}
            openComposerRequestId={
              section === 'agents' && quickAddRequest?.target === 'agents'
                ? quickAddRequest.id
                : undefined
            }
            onOpenComposerRequestConsumed={onQuickAddRequestConsumed}
            translate={translate}
          />
        )}
      />{' '}
    </>
  )
}
