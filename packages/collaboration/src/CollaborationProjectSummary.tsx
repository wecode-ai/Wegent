// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationProject } from './types'

export function CollaborationProjectSummary({
  project,
  description,
  leading,
}: {
  project: Pick<CollaborationProject, 'project_key' | 'name' | 'description'>
  description?: string
  leading?: React.ReactNode
}) {
  return (
    <span className="collaboration-project-summary">
      {leading}
      <span className="collaboration-project-summary-copy">
        <span className="collaboration-project-summary-title">{project.name}</span>
        <span className="collaboration-project-summary-description">
          {description ?? project.description ?? project.project_key}
        </span>
      </span>
    </span>
  )
}
