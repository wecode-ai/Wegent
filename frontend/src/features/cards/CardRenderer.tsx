// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getCardComponent } from './registry'
import type { CardRendererProps } from './types'

export function CardRenderer({ block, taskId, subtaskId, onChatButtonClick }: CardRendererProps) {
  const Component = getCardComponent(block.card_type)

  return Component ? (
    <Component
      block={block}
      taskId={taskId}
      subtaskId={subtaskId}
      onChatButtonClick={onChatButtonClick}
    />
  ) : null
}
