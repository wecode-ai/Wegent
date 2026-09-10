// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ComponentType, ReactNode, SVGProps } from 'react'

import type { CollaborationIssue, CollaborationMember, CollaborationProject } from '../types'
import {
  WorkspaceProjectsHome,
  type WorkspaceProjectsHomeHost,
} from '../workspace/WorkspaceProjectsHome'

type IconProps = SVGProps<SVGSVGElement>

function Icon({
  children,
  ...props
}: IconProps & {
  children: ReactNode
}) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      {...props}
    >
      {children}
    </svg>
  )
}

function icon(children: ReactNode): ComponentType<IconProps> {
  return function WorkspaceHomeIcon(props: IconProps) {
    return <Icon {...props}>{children}</Icon>
  }
}

const icons = {
  Check: icon(<path d="m5 12 4 4L19 6" />),
  Cloud: icon(<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 0 1 0 9Z" />),
  Copy: icon(
    <>
      <rect width="14" height="14" x="8" y="8" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  HardDrive: icon(
    <>
      <line x1="22" x2="2" y1="12" y2="12" />
      <path d="m5.45 5.11-2.4 4.8A2 2 0 0 0 2 11.79V19a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-7.21a2 2 0 0 0-.21-.89l-2.4-4.8A2 2 0 0 0 17.6 5H7.24a2 2 0 0 0-1.79.11Z" />
      <line x1="6" x2="6.01" y1="16" y2="16" />
      <line x1="10" x2="10.01" y1="16" y2="16" />
    </>
  ),
  Plus: icon(
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  Search: icon(
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  Settings: icon(
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
}

export interface WorkspaceProjectsHomeAdapterProps {
  projects: CollaborationProject[]
  projectItems: Record<string, CollaborationIssue[]>
  projectMembers: Record<string, CollaborationMember[]>
  onCreateProject(): void
  onSelectProject(project: CollaborationProject): void
  onManageProject(project: CollaborationProject): void
  onUnavailable(): void
}

function translateFallback(
  _key: string,
  fallback: string,
  options?: Record<string, string | number>
): string {
  return Object.entries(options ?? {}).reduce(
    (value, [name, replacement]) => value.split(`{{${name}}}`).join(String(replacement)),
    fallback
  )
}

const host: WorkspaceProjectsHomeHost = {
  icons,
  translate: translateFallback,
  async copyText(text) {
    await navigator.clipboard.writeText(text)
  },
  formatRelativeTime(value) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(value))
  },
  renderTooltip: ({ label, children }) => <span title={label}>{children}</span>,
  renderModal: ({ title, onClose, children }) => (
    <div className="collaboration-dialog-backdrop">
      <section
        aria-label={title}
        aria-modal="true"
        className="collaboration-dialog collaboration-workspace-home-dialog"
        role="dialog"
      >
        <header className="collaboration-workspace-home-dialog-header">
          <h2>{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  ),
}

export function WorkspaceProjectsHomeAdapter({
  projects,
  projectItems,
  projectMembers,
  onCreateProject,
  onSelectProject,
  onManageProject,
  onUnavailable,
}: WorkspaceProjectsHomeAdapterProps) {
  const workspaceProjects = projects.map(project => ({
    ...project,
    location: project.project_store === 'local' ? ('local' as const) : ('cloud' as const),
  }))
  const workspaceItems = Object.fromEntries(
    workspaceProjects.map(project => [
      `${project.project_store}:${project.id}`,
      projectItems[project.id] ?? [],
    ])
  )
  const workspaceMembers = Object.fromEntries(
    workspaceProjects.map(project => [
      `${project.project_store}:${project.id}`,
      projectMembers[project.id] ?? [],
    ])
  )
  const projectCounts = Object.fromEntries(
    Object.entries(workspaceItems).map(([key, items]) => [key, items.length])
  )
  const myWork = workspaceProjects.flatMap(project =>
    (projectItems[project.id] ?? [])
      .filter(item => item.assignee_user_id === project.current_user_id)
      .map(item => ({ ...item, project_key: project.project_key }))
  )

  return (
    <WorkspaceProjectsHome<
      (typeof workspaceProjects)[number],
      CollaborationIssue,
      CollaborationIssue & { project_key: string },
      CollaborationMember
    >
      projects={workspaceProjects}
      projectCounts={projectCounts}
      projectMembers={workspaceMembers}
      projectItems={workspaceItems}
      myWork={myWork}
      searchQuery=""
      host={host}
      onCreateProject={onCreateProject}
      onSelectProject={onSelectProject}
      onManageProject={onManageProject}
      onSelectItem={onUnavailable}
      onOpenMyWork={onUnavailable}
    />
  )
}
