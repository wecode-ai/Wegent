// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'
import {
  hasGroupedProjectViews,
  resolveGroupedProjectView,
} from '../workspace-header/projectViewNavigation'
import { canAccessCollaborationProjectView } from '../permissions'
import type { CollaborationProject } from '../types'
import type {
  CollaborationProjectView,
  CollaborationProjectViewOption,
  ProjectViewMetadata,
  ProjectViewMetadataMap,
} from '../workspace-header/ProjectViewSwitcher'

export const collaborationProjectViewIds = ['board', 'table', 'files', 'manage'] as const

export type StandardCollaborationProjectView = (typeof collaborationProjectViewIds)[number]

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
  const accessibleView = options.some(option => option.id === view)
    ? view
    : hasGroupedProjectViews(options)
      ? (resolveGroupedProjectView(options, view) ?? 'board')
      : 'board'
  const extensionContent = extensions.find(extension => extension.id === accessibleView)?.content
  const content =
    extensionContent ??
    (collaborationProjectViewIds.includes(accessibleView as StandardCollaborationProjectView)
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
  onViewChange: (view: CollaborationProjectView) => void
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
      view => enabledStandardViewIds.has(view) && canAccessCollaborationProjectView(project, view)
    )
    .map(view => ({
      id: view,
      label: labels[view],
      testId: testIds[view],
      ...viewMetadata?.[view],
    }))
  const standardIds = new Set<CollaborationProjectView>(standardOptions.map(option => option.id))
  const extensionOptions = extensions
    .filter(extension => extension.available !== false && !standardIds.has(extension.id))
    .map(({ id, label, testId, group, parent, oldTestIdAliases, after = 'board' }) => ({
      id,
      label,
      testId,
      after,
      ...(group ? { group } : {}),
      ...(parent ? { parent } : {}),
      ...(oldTestIdAliases ? { oldTestIdAliases } : {}),
      ...viewMetadata?.[id],
    }))

  return [
    ...standardOptions.flatMap(option => [
      option,
      ...extensionOptions.flatMap(({ after, ...extension }) =>
        after === option.id ? [extension] : []
      ),
    ]),
    // An ordering anchor never determines whether an available view exists.
    ...extensionOptions.flatMap(({ after, ...extension }) =>
      !standardIds.has(after) ? [extension] : []
    ),
  ]
}

export type CollaborationProjectViewConfiguration = Parameters<
  typeof buildCollaborationProjectViewOptions
>[0] & {
  view: CollaborationProjectView
  slots: CollaborationProjectViewSlots
}

/** Resolve once from the host's available capabilities without changing its route. */
export function resolveCollaborationProjectViewNavigation(
  configuration: CollaborationProjectViewConfiguration
) {
  const options = buildCollaborationProjectViewOptions(configuration)
  return {
    requestedView: configuration.view,
    options,
    grouped: hasGroupedProjectViews(options),
    resolved: resolveCollaborationProjectView({
      extensions: configuration.extensions ?? [],
      options,
      slots: configuration.slots,
      view: configuration.view,
    }),
  }
}

export interface CollaborationProjectViewNavigationReceipt {
  requestedView: CollaborationProjectView
  grouped: boolean
  resolved: ResolvedCollaborationProjectView
  onUnavailableView?(resolved: ResolvedCollaborationProjectView): void
}
