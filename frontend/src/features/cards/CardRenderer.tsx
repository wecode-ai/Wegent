// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CardBlock } from '@/features/tasks/components/message/thinking/types'
import { getCardComponent } from './registry'

export function CardRenderer({ block }: { block: CardBlock }) {
  const Component = getCardComponent(block.card_type)
  return Component ? <Component block={block} /> : null
}
