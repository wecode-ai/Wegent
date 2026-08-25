// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from 'react'
import { getCardComponent } from './registry'
import type { CardRendererProps } from './types'

export function CardRenderer({ block, taskId, subtaskId, onChatButtonClick }: CardRendererProps) {
  const Component = getCardComponent(block.card_type)

  useEffect(() => {
    console.info('[CardRenderer][rendered]', {
      task_id: taskId ?? null,
      subtask_id: subtaskId ?? null,
      card_id: block.card_id,
      card_type: block.card_type,
      card_status: block.card_status,
      component_found: Boolean(Component),
    })
  }, [Component, block.card_id, block.card_status, block.card_type, subtaskId, taskId])

  return Component ? (
    <Component
      block={block}
      taskId={taskId}
      subtaskId={subtaskId}
      onChatButtonClick={onChatButtonClick}
    />
  ) : null
}
