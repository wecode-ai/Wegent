// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ProjectBoardColumn } from './ProjectBoardBody'
import type { ProjectBoardGroupBy } from './useProjectBoardState'

export function isExecutionBoardColumn(
  column: ProjectBoardColumn,
  groupBy: ProjectBoardGroupBy
): boolean {
  return (
    (column.type ?? groupBy) === 'status' &&
    (column.status === 'in_progress' || column.status === 'in_review')
  )
}
