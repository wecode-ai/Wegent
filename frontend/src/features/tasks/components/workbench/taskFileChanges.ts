// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { UnifiedMessage } from '@wegent/chat-core'
import type { TaskFileChanges } from '@/types/api'

/** Each completed snapshot already contains the net changes from the task baseline. */
export function selectTaskFileChanges(messages: Iterable<UnifiedMessage>): TaskFileChanges | null {
  const turns = Array.from(messages)
    .filter(message => message.type === 'ai' && message.status === 'completed')
    .sort((left, right) => {
      // Match conversation ordering: recovered and live timestamps may use different clocks.
      if (left.messageId !== undefined && right.messageId !== undefined) {
        return left.messageId - right.messageId || left.timestamp - right.timestamp
      }
      if (left.messageId !== undefined) return -1
      if (right.messageId !== undefined) return 1
      return left.timestamp - right.timestamp
    })
    .map(
      message =>
        (message.result as { task_file_changes?: TaskFileChanges } | undefined)?.task_file_changes
    )
    .filter((changes): changes is TaskFileChanges =>
      Boolean(
        changes &&
        (changes.status === 'active' || changes.status === 'error') &&
        Array.isArray(changes.files) &&
        typeof changes.diff === 'string'
      )
    )
  return turns[turns.length - 1] || null
}
