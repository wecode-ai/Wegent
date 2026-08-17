// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ComponentType } from 'react'
import type { CardBlock } from '@/features/tasks/components/message/thinking/types'

export interface AsyncCardComponentProps {
  card: CardBlock
  taskId?: number
  subtaskId?: number
  onSendMessage?: (content: string) => void
}

export type AsyncCardComponent = ComponentType<AsyncCardComponentProps>
