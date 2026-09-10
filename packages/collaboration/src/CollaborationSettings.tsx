// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo, type ComponentType, type SVGProps } from 'react'

import {
  ProjectManageView,
  type ProjectManageApi,
  type ProjectManageCardDisplay,
  type ProjectManageHost,
  type ProjectManageStatus,
} from './project-manage'
import type { SharedWorkspaceApi } from './ports/SharedWorkspaceApi'
import type {
  CollaborationIssue,
  CollaborationMember,
  CollaborationProject,
  CollaborationUser,
} from './types'

interface CollaborationSettingsProps {
  api: SharedWorkspaceApi
  project: CollaborationProject
  onChange(project: CollaborationProject): void
  onError(): void
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

function moveStatus(
  statuses: ProjectManageStatus[],
  index: number,
  offset: -1 | 1
): ProjectManageStatus[] {
  const target = index + offset
  if (target < 0 || target >= statuses.length) return statuses
  const next = [...statuses]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

function WebBoardLayout({
  statuses,
  display,
  statusBusy,
  displayBusy,
  canEditStatuses,
  onStatusesChange,
  onDisplayChange,
}: {
  statuses: ProjectManageStatus[]
  display: ProjectManageCardDisplay
  statusBusy: boolean
  displayBusy: boolean
  canEditStatuses: boolean
  onStatusesChange(statuses: ProjectManageStatus[]): void
  onDisplayChange(key: keyof ProjectManageCardDisplay, checked: boolean): void
}) {
  return (
    <section className="border-t border-border py-6">
      <h2 className="text-heading-md font-semibold">看板布局</h2>
      <p className="mt-1 text-sm text-text-muted">配置项目状态和任务卡片显示内容。</p>
      {canEditStatuses && (
        <div className="mt-4 space-y-2">
          {statuses.map((status, index) => (
            <div className="flex items-center gap-2" key={status.id}>
              <input
                aria-label="状态名称"
                className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3"
                value={status.name}
                disabled={statusBusy}
                onChange={event =>
                  onStatusesChange(
                    statuses.map(item =>
                      item.id === status.id ? { ...item, name: event.target.value } : item
                    )
                  )
                }
              />
              <button
                type="button"
                disabled={statusBusy || index === 0}
                onClick={() => onStatusesChange(moveStatus(statuses, index, -1))}
              >
                上移
              </button>
              <button
                type="button"
                disabled={statusBusy || index === statuses.length - 1}
                onClick={() => onStatusesChange(moveStatus(statuses, index, 1))}
              >
                下移
              </button>
              <button
                type="button"
                disabled={statusBusy || statuses.length === 1}
                onClick={() => onStatusesChange(statuses.filter(item => item.id !== status.id))}
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {(
          [
            ['showAssignee', '显示负责人'],
            ['showPriority', '显示优先级'],
            ['showTags', '显示标签'],
            ['showDate', '显示日期'],
          ] as const
        ).map(([key, label]) => (
          <label className="flex items-center gap-2" key={key}>
            <input
              type="checkbox"
              checked={display[key]}
              disabled={displayBusy}
              onChange={event => onDisplayChange(key, event.target.checked)}
            />
            {label}
          </label>
        ))}
      </div>
    </section>
  )
}

export function CollaborationSettings({
  api,
  project,
  onChange,
  onError,
}: CollaborationSettingsProps) {
  const manageApi = useMemo<
    ProjectManageApi<
      CollaborationProject,
      CollaborationMember,
      CollaborationIssue,
      CollaborationUser
    >
  >(
    () => ({
      listMembers: projectId => api.members.list(projectId),
      listItems: async projectId => {
        const snapshot = await api.issues.getBoardSnapshot(projectId)
        return { items: snapshot.items }
      },
      searchUsers: async query => ({ users: await api.members.searchUsers(query) }),
      addMember: (projectId, userId, role) =>
        api.members.add(projectId, userId, role === 'Owner' ? undefined : role),
      updateMember: (projectId, userId, values) =>
        api.members.update(projectId, userId, {
          role: values.role,
          capabilityDescription: values.capability_description,
        }),
      removeMember: (projectId, userId) => api.members.remove(projectId, userId),
      updateItem: (itemId, values) =>
        api.issues.update(itemId, {
          version: values.version,
          tags: values.tags,
        }),
      updateProject: (projectId, values) =>
        api.projects.update(projectId, {
          version: values.version,
          tags: values.tags,
          visibility: values.visibility,
          providerConfig: values.provider_config,
          boardConfig: values.board_config,
          cardDisplay: values.card_display,
        }),
    }),
    [api]
  )

  const host = useMemo<ProjectManageHost>(
    () => ({
      icons: manageIcons,
      translate: (_key, fallback, options) =>
        Object.entries(options ?? {}).reduce(
          (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
          fallback
        ),
      confirm: message => window.confirm(message),
      trackCompleted: () => undefined,
      trackFailed: onError,
      renderTooltip: ({ label, children }) => <span title={label}>{children}</span>,
      renderActionMenu: ({ ariaLabel, testId, triggerClassName, items }) => (
        <details className="relative">
          <summary aria-label={ariaLabel} className={triggerClassName} data-testid={testId}>
            ···
          </summary>
          <div className="absolute right-0 z-10 min-w-28 rounded-lg border border-border bg-background p-1 shadow-lg">
            {items.map(item => {
              const Icon = item.icon as ComponentType<{ className?: string }>
              return (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                  data-testid={item.testId}
                  disabled={item.disabled}
                  key={item.testId}
                  onClick={() => void item.onSelect()}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                </button>
              )
            })}
          </div>
        </details>
      ),
      renderBoardLayout: options => <WebBoardLayout {...options} />,
    }),
    [onError]
  )

  return (
    <ProjectManageView api={manageApi} host={host} project={project} onProjectUpdated={onChange} />
  )
}
