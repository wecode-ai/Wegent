// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, type ReactNode } from 'react'

import { canAccessCollaborationProjectView } from '../permissions'
import type { CollaborationProject } from '../types'
import {
  ProjectViewSwitcher,
  type CollaborationProjectView,
  type CollaborationProjectViewOption,
  hasGroupedProjectViews,
  resolveGroupedProjectView,
  type ProjectViewMetadata,
  type ProjectViewMetadataMap,
  type ProjectViewSelectionMemory,
} from '../workspace-header/ProjectViewSwitcher'
import { ProjectShell, type ProjectShellProps } from './ProjectShell'

export const collaborationProjectViewIds = [
  'board',
  'table',
  'files',
  'manage',
] as const

export type StandardCollaborationProjectView =
  (typeof collaborationProjectViewIds)[number]

export interface CollaborationProjectViewLabels {
  board: string
  table: string
  files: string
  manage: string
}

export interface CollaborationProjectViewTestIds {
  board: string
  table: string
  files: string
  manage: string
}

export interface CollaborationProjectViewExtension extends ProjectViewMetadata {
  id: CollaborationProjectView
  label: string
  testId: string
  content: ReactNode
  available?: boolean
  after?: StandardCollaborationProjectView
}

export interface CollaborationProjectViewSlots {
  board: ReactNode
  table: ReactNode
  files: ReactNode
  manage: ReactNode
}

export interface ResolvedCollaborationProjectView {
  content: ReactNode
  view: CollaborationProjectView
  viewChanged: boolean
}

export function resolveCollaborationProjectView({
  extensions,
  options,
  slots,
  view,
}: {
  extensions: CollaborationProjectViewExtension[]
  options: CollaborationProjectViewOption[]
  slots: CollaborationProjectViewSlots
  view: CollaborationProjectView
}): ResolvedCollaborationProjectView {
  const accessibleView = options.some((option) => option.id === view)
    ? view
    : hasGroupedProjectViews(options)
      ? (resolveGroupedProjectView(options, view) ?? 'board')
      : 'board'
  const extensionContent = extensions.find(
    (extension) => extension.id === accessibleView,
  )?.content
  const content =
    extensionContent ??
    (collaborationProjectViewIds.includes(
      accessibleView as StandardCollaborationProjectView,
    )
      ? slots[accessibleView as StandardCollaborationProjectView]
      : null)

  return {
    content,
    view: accessibleView,
    viewChanged: accessibleView !== view,
  }
}

export function synchronizeCollaborationProjectView(
  resolved: ResolvedCollaborationProjectView,
  onViewChange: (view: CollaborationProjectView) => void,
): void {
  if (resolved.viewChanged) onViewChange(resolved.view)
}

export function buildCollaborationProjectViewOptions({
  project,
  labels,
  testIds,
  enabledStandardViews = collaborationProjectViewIds,
  extensions = [],
  viewMetadata,
}: {
  project: Pick<CollaborationProject, 'access_role' | 'project_store'>
  labels: CollaborationProjectViewLabels
  testIds: CollaborationProjectViewTestIds
  enabledStandardViews?: readonly StandardCollaborationProjectView[]
  extensions?: CollaborationProjectViewExtension[]
  viewMetadata?: ProjectViewMetadataMap
}): CollaborationProjectViewOption[] {
  const enabledStandardViewIds = new Set(enabledStandardViews)
  const standardOptions = collaborationProjectViewIds
    .filter(
      (view) =>
        enabledStandardViewIds.has(view) &&
        canAccessCollaborationProjectView(project, view),
    )
    .map((view) => ({
      id: view,
      label: labels[view],
      testId: testIds[view],
      ...viewMetadata?.[view],
    }))
  const standardIds = new Set<CollaborationProjectView>(
    standardOptions.map((option) => option.id),
  )
  const extensionOptions = extensions
    .filter(
      (extension) =>
        extension.available !== false && !standardIds.has(extension.id),
    )
    .map(
      ({
        id,
        label,
        testId,
        group,
        parent,
        oldTestIdAliases,
        after = 'board',
      }) => ({
        id,
        label,
        testId,
        after,
        ...(group ? { group } : {}),
        ...(parent ? { parent } : {}),
        ...(oldTestIdAliases ? { oldTestIdAliases } : {}),
        ...viewMetadata?.[id],
      }),
    )

  const availableOptions = [
    ...standardOptions,
    ...extensionOptions.map(({ after: _after, ...option }) => option),
  ]
  // Grouped navigation has its own fixed order; flat anchors cannot hide a view.
  if (hasGroupedProjectViews(availableOptions)) return availableOptions

  return standardOptions.flatMap((option) => [
    option,
    ...extensionOptions
      .filter((extension) => extension.after === option.id)
      .map(({ after: _after, ...option }) => option),
  ])
}

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
  onUnavailableView?(resolved: ResolvedCollaborationProjectView): void
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
  onUnavailableView,
  ...shellProps
}: CollaborationProjectViewShellProps) {
  const options = buildCollaborationProjectViewOptions({
    project,
    labels,
    testIds,
    enabledStandardViews,
    extensions,
    viewMetadata,
  })
  const grouped = hasGroupedProjectViews(options)
  const resolved = resolveCollaborationProjectView({
    extensions,
    options,
    slots,
    view,
  })

  useEffect(() => {
    if (grouped) {
      if (resolved.viewChanged) onUnavailableView?.(resolved)
    } else {
      synchronizeCollaborationProjectView(resolved, onViewChange)
    }
  }, [
    grouped,
    onUnavailableView,
    onViewChange,
    resolved.view,
    resolved.viewChanged,
  ])

  return (
    <ProjectShell
      {...shellProps}
      viewSwitcherPlacement={grouped ? 'below-header' : 'header'}
      boardView={
        resolved.view === 'board' ||
        resolved.view === 'calendar' ||
        resolved.view === 'gantt'
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
