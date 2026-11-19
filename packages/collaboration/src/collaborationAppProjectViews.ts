// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { collaborationTestIds } from './testIds'
import type { collaborationMessages } from './i18n'
import type { CollaborationProject, CollaborationView } from './types'
import {
  resolveCollaborationProjectViewNavigation,
  type CollaborationProjectViewExtension,
} from './project-shell/projectViewResolution'

export function collaborationAppProjectViewCatalog(
  messages: (typeof collaborationMessages)[keyof typeof collaborationMessages],
  milestoneTitle: string,
  milestonesEnabled: boolean
) {
  return {
    labels: {
      board: messages.board,
      table: messages.table,
      files: messages.files,
      manage: messages.settings,
    },
    testIds: {
      board: 'collaboration-tab-board',
      table: 'collaboration-tab-table',
      files: 'collaboration-tab-files',
      manage: 'collaboration-tab-manage',
    },
    extensions: {
      milestones: {
        id: 'milestones',
        after: 'table',
        label: milestoneTitle,
        testId: 'collaboration-milestones-tab',
        available: milestonesEnabled,
        content: null,
      },
      calendar: {
        id: 'calendar',
        label: messages.calendar,
        testId: `${collaborationTestIds.calendar}-tab`,
        content: null,
      },
      gantt: {
        id: 'gantt',
        label: messages.gantt,
        testId: `${collaborationTestIds.gantt}-tab`,
        content: null,
      },
    } satisfies Record<string, CollaborationProjectViewExtension>,
  }
}

export function resolveCollaborationAppProjectView(
  project: CollaborationProject,
  view: CollaborationView,
  catalog: ReturnType<typeof collaborationAppProjectViewCatalog>
) {
  return resolveCollaborationProjectViewNavigation({
    project,
    view,
    labels: catalog.labels,
    testIds: catalog.testIds,
    extensions: Object.values(catalog.extensions),
    slots: { board: null, table: null, files: null, manage: null },
  })
}
