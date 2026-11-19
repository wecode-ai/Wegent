// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export * from './ProjectShell'
export * from './CollaborationProjectViewShell'
export * from './ProjectLoadingSkeleton'

export {
  collaborationProjectViewIds,
  buildCollaborationProjectViewOptions,
  resolveCollaborationProjectView,
  synchronizeCollaborationProjectView,
  resolveCollaborationProjectViewNavigation,
} from './projectViewResolution'
export type {
  CollaborationProjectViewConfiguration,
  CollaborationProjectViewNavigationReceipt,
} from './projectViewResolution'
export * from './projectSurfaces'
export * from './projectSurfaceRouting'
