// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationExecutionEnvironment } from '../types'

const statusOrder = { online: 0, provisioning: 1, error: 2, offline: 3 }

export function compareExecutionEnvironments(
  left: CollaborationExecutionEnvironment,
  right: CollaborationExecutionEnvironment
): number {
  return (
    Number(right.is_current_device === true) - Number(left.is_current_device === true) ||
    statusOrder[left.status] - statusOrder[right.status] ||
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }) ||
    left.id.localeCompare(right.id, undefined, { numeric: true })
  )
}
