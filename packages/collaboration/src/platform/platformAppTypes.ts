// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type {
  CollaborationProject,
  CollaborationIssue,
  CollaborationWorkspace,
  CollaborationWorkspaceNavigationContext,
} from '../types'
import type { CollaborationLocale } from '../i18n'
import type { CollaborationPlatformHostAdapter } from './types'

export type CollaborationProjectRendererWorkspaceContext =
  | CollaborationWorkspace
  | CollaborationWorkspaceNavigationContext

export interface CollaborationProjectRendererContext {
  project: CollaborationProject
  workspace: CollaborationProjectRendererWorkspaceContext | null
}

export interface CollaborationPlatformAppProps {
  api: SharedWorkspaceApi
  refreshKey?: string
  navigationApis?: SharedWorkspaceApi[]
  host: CollaborationPlatformHostAdapter
  locale?: CollaborationLocale
  onCreateTask?(
    project: CollaborationProject,
    issue: CollaborationIssue,
    workflowStep?: string
  ): void
  onReady?(): void
  renderProject?(context: CollaborationProjectRendererContext): ReactNode
  renderShell?(shell: {
    main: ReactNode
    sidebar: ReactNode
    mobileNavigation?: { open: boolean; setOpen(open: boolean): void }
  }): ReactNode
  sidebarFooter?: ReactNode
  normalizePastedFiles?(files: File[]): Promise<File[]>
}
