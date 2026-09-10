// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ComponentType, ReactNode } from 'react'

export type ProjectManageRole = 'Owner' | 'Maintainer' | 'Developer' | 'Reporter'
export type ProjectManageVisibility = 'private' | 'public'
export type ProjectManageStatusColor = 'gray' | 'blue' | 'orange' | 'purple' | 'green' | 'red'

export interface ProjectManageStatus {
  id: string
  name: string
  color: ProjectManageStatusColor
}

export interface ProjectManageCardDisplay {
  showAssignee: boolean
  showPriority: boolean
  showTags: boolean
  showDate: boolean
}

export interface ProjectManageProject {
  id: string
  task_provider: string
  provider_config: {
    repository?: string
    domain?: string
    api_base?: string
    credential_configured?: boolean
    [key: string]: unknown
  }
  card_display?: {
    show_assignee: boolean
    show_priority: boolean
    show_tags: boolean
    show_date: boolean
  }
  board_config?: {
    group_by: 'status' | 'priority' | 'assignee' | 'tag'
    processing_start_status_id: string | null
    statuses: ProjectManageStatus[]
  }
  visibility?: ProjectManageVisibility
  tags: string[]
  version: number
}

export interface ProjectManageMember {
  user_id: number
  user_name: string
  email: string | null
  role: ProjectManageRole
  capability_description?: string
}

export interface ProjectManageUser {
  id: number
  user_name: string
  email: string | null
}

export interface ProjectManageItem {
  id: string
  version: number
  tags: string[]
}

export interface ProjectManageUpdate {
  version: number
  tags?: string[]
  visibility?: ProjectManageVisibility
  card_display?: {
    show_assignee: boolean
    show_priority: boolean
    show_tags: boolean
    show_date: boolean
  }
  board_config?: {
    group_by: 'status' | 'priority' | 'assignee' | 'tag'
    processing_start_status_id: string | null
    statuses: ProjectManageStatus[]
  }
  provider_config?: Record<string, unknown>
}

export interface ProjectManageApi<
  Project extends ProjectManageProject,
  Member extends ProjectManageMember,
  Item extends ProjectManageItem,
  User extends ProjectManageUser,
> {
  listMembers(projectId: string): Promise<Member[]>
  listItems(projectId: string): Promise<{ items: Item[] }>
  searchUsers(query: string): Promise<{ users: User[] }>
  addMember(projectId: string, userId: number, role: ProjectManageRole): Promise<Member>
  updateMember(
    projectId: string,
    userId: number,
    values: {
      role?: Exclude<ProjectManageRole, 'Owner'>
      capability_description?: string
    }
  ): Promise<Member>
  removeMember(projectId: string, userId: number): Promise<void>
  updateItem(itemId: string, values: { version: number; tags: string[] }): Promise<Item>
  updateProject(projectId: string, values: ProjectManageUpdate): Promise<Project>
}

export interface ProjectManageMenuItem {
  label: string
  icon: ComponentType<{ className?: string }>
  onSelect(): void | Promise<void>
  testId: string
  danger?: boolean
  disabled?: boolean
}

export interface ProjectManageHost {
  icons: {
    Check: ComponentType<{ className?: string }>
    GitBranch: ComponentType<{ className?: string }>
    LockKeyhole: ComponentType<{ className?: string }>
    Pencil: ComponentType<{ className?: string }>
    Search: ComponentType<{ className?: string }>
    Trash2: ComponentType<{ className?: string }>
    X: ComponentType<{ className?: string }>
  }
  translate(key: string, fallback: string, options?: Record<string, string | number>): string
  confirm(message: string): boolean
  trackCompleted(action: 'update' | 'member_invite' | 'member_role_change' | 'member_remove'): void
  trackFailed(): void
  renderTooltip(options: { label: string; align?: 'end'; children: ReactNode }): ReactNode
  renderActionMenu(options: {
    ariaLabel: string
    testId: string
    placement: 'bottom-end'
    triggerClassName: string
    items: ProjectManageMenuItem[]
  }): ReactNode
  renderBoardLayout(options: {
    statuses: ProjectManageStatus[]
    display: ProjectManageCardDisplay
    statusBusy: boolean
    displayBusy: boolean
    canEditStatuses: boolean
    onStatusesChange(statuses: ProjectManageStatus[]): void
    onDisplayChange(key: keyof ProjectManageCardDisplay, checked: boolean): void
  }): ReactNode
}

export interface ProjectManageExtensionContext<Project extends ProjectManageProject> {
  updateProject(values: Omit<ProjectManageUpdate, 'version'>): Promise<Project>
  reportError(cause: unknown, fallback: string): void
}
