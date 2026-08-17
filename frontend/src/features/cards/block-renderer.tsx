// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { AsyncCardRenderer } from './components/AsyncCardRenderer'
import { blockRendererRegistry } from '@/features/tasks/components/message/block-registry'
import type { CardBlock } from '@/features/tasks/components/message/thinking/types'

blockRendererRegistry.register({
  id: 'async-card',
  priority: 100,
  canRender: block => block.type === 'card',
  render: ({ block, taskId, subtaskId, onSendMessage }) => (
    <AsyncCardRenderer
      card={block as CardBlock}
      taskId={taskId}
      subtaskId={subtaskId}
      onSendMessage={onSendMessage}
    />
  ),
})
