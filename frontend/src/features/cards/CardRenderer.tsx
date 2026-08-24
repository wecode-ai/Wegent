// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CardBlock } from '@/features/tasks/components/message/thinking/types'
import { getCardComponent } from './registry'

export function CardRenderer({
  block,
  onChatButtonClick,
}: {
  block: CardBlock
  onChatButtonClick?: (message: string) => void | Promise<void>
}) {
  const Component = getCardComponent(block.card_type)
  return Component ? <Component block={block} onChatButtonClick={onChatButtonClick} /> : null
}
