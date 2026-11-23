// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'

import type { CollaborationProject } from '../types'
import {
  ProjectViewSwitcher,
  type CollaborationProjectView,
  type ProjectViewMetadataMap,
  type ProjectViewSelectionMemory,
} from '../workspace-header/ProjectViewSwitcher'
import { ProjectShell, type ProjectShellProps } from './ProjectShell'

export type {
  StandardCollaborationProjectView,
  CollaborationProjectViewLabels,
  CollaborationProjectViewTestIds,
  CollaborationProjectViewExtension,
  CollaborationProjectViewSlots,
  ResolvedCollaborationProjectView,
} from './projectViewResolution'
import {
  resolveCollaborationProjectViewNavigation,
  type StandardCollaborationProjectView,
  type CollaborationProjectViewLabels,
  type CollaborationProjectViewTestIds,
  type CollaborationProjectViewExtension,
  type CollaborationProjectViewSlots,
} from './projectViewResolution'
export interface CollaborationProjectViewShellProps extends Omit<
  ProjectShellProps,
  'boardView' | 'children' | 'renderViewSwitcher' | 'viewSwitcherPlacement'
> {
  project: Pick<CollaborationProject, 'access_role' | 'project_store'>
  view: CollaborationProjectView
  labels: CollaborationProjectViewLabels
  testIds: CollaborationProjectViewTestIds
  slots: CollaborationProjectViewSlots
  enabledStandardViews?: readonly StandardCollaborationProjectView[]
  extensions?: CollaborationProjectViewExtension[]
  switcherAriaLabel?: string
  compactSwitcherIcon?: ReactNode
  viewMetadata?: ProjectViewMetadataMap
  viewSwitcherLocale?: 'zh-CN' | 'en'
  viewSelectionMemory?: ProjectViewSelectionMemory
  viewSelectionKey?: string
  onViewChange(view: CollaborationProjectView): void
}

export function CollaborationProjectViewShell({
  project,
  view,
  labels,
  testIds,
  slots,
  enabledStandardViews,
  extensions = [],
  switcherAriaLabel,
  compactSwitcherIcon,
  onViewChange,
  viewMetadata,
  viewSwitcherLocale,
  viewSelectionMemory,
  viewSelectionKey,
  ...shellProps
}: CollaborationProjectViewShellProps) {
  const { options, grouped, resolved } = resolveCollaborationProjectViewNavigation({
    project,
    labels,
    testIds,
    enabledStandardViews,
    extensions,
    viewMetadata,
    slots,
    view,
  })

  return (
    <ProjectShell
      {...shellProps}
      compactTitle={resolved.view === 'manage' ? shellProps.compactTitle : undefined}
      viewSwitcherPlacement={grouped ? 'below-header' : 'header'}
      boardView={
        resolved.view === 'board' || resolved.view === 'calendar' || resolved.view === 'gantt'
      }
      renderViewSwitcher={({ compact, containerRef }) =>
        options.length > 1 || grouped ? (
          <ProjectViewSwitcher
            ariaLabel={switcherAriaLabel}
            compact={compact}
            compactIcon={compactSwitcherIcon}
            containerRef={containerRef}
            value={resolved.view}
            options={options}
            onChange={onViewChange}
            locale={viewSwitcherLocale}
            selectionMemory={viewSelectionMemory}
            selectionKey={viewSelectionKey}
          />
        ) : null
      }
    >
      {resolved.content}
    </ProjectShell>
  )
}
