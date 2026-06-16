// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const PROJECT_DELETED_EVENT = 'wegent:project-deleted'

export interface ProjectDeletedEventDetail {
  projectId: number
}

export function dispatchProjectDeletedEvent(projectId: number) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<ProjectDeletedEventDetail>(PROJECT_DELETED_EVENT, {
      detail: { projectId },
    })
  )
}
