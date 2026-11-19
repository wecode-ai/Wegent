import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ConversationQueuePanel } from '@wegent/collaboration/conversation/ConversationQueuePanel'
import { createCollaborationTranslator } from '@wegent/collaboration'
import {
  reorderLocalQueuedMessages,
  type QueuedWorkbenchMessage,
} from '@wegent/chat-core/conversation-queue'
import { useTranslation } from '@/hooks/useTranslation'

const meta = {
  title: 'Business/ConversationQueue',
  component: ConversationQueuePanel,
  parameters: {
    docs: {
      description: {
        component:
          'Production queue and shared ordering logic. Local queued messages can move; sending, server-owned and failed messages retain their slots. Actions only update this preview. / 真实队列与公共排序逻辑：本地待发送消息可排序，发送中、服务端队列与失败消息保持原位置；操作只影响当前示例。',
      },
    },
  },
} satisfies Meta<typeof ConversationQueuePanel>
export default meta
type Story = StoryObj<Record<string, never>>

function Example({ readonly = false, paused = false }) {
  const { t, i18n } = useTranslation('componentCatalog')
  const [messages, setMessages] = useState<QueuedWorkbenchMessage[]>([
    { id: 'sending', content: 'Sending / 正在发送', status: 'sending', createdAt: '' },
    { id: 'one', content: 'First local message / 第一条本地消息', status: 'queued', createdAt: '' },
    {
      id: 'server',
      content: 'Runtime queue / 运行时队列',
      status: 'queued',
      runtimeQueued: true,
      runtimeQueuePosition: 1,
      createdAt: '',
    },
    {
      id: 'two',
      content: 'Second local message / 第二条本地消息',
      status: 'queued',
      createdAt: '',
    },
    {
      id: 'failed',
      content: 'Failed message / 失败消息',
      status: 'failed',
      error: 'Example error / 示例错误',
      createdAt: '',
    },
  ])
  const [queuePaused, setQueuePaused] = useState(paused)
  const [result, setResult] = useState('')
  return (
    <div className="max-w-3xl space-y-4">
      <ConversationQueuePanel
        translate={createCollaborationTranslator(i18n.language === 'en' ? 'en' : 'zh-CN')}
        queuedMessages={messages}
        guidanceMessages={[]}
        queuePaused={queuePaused}
        onResumeQueue={readonly ? undefined : () => setQueuePaused(false)}
        onCancelQueuedMessage={
          readonly
            ? undefined
            : id => setMessages(current => current.filter(message => message.id !== id))
        }
        onForceStartQueuedMessage={
          readonly
            ? undefined
            : id =>
                setMessages(current =>
                  current.map(message =>
                    message.id === id ? { ...message, status: 'sending' } : message
                  )
                )
        }
        onEditQueuedMessage={readonly ? undefined : id => setResult(id)}
        onReorderQueuedMessages={
          readonly
            ? undefined
            : (source, target) =>
                setMessages(current => reorderLocalQueuedMessages(current, source, target))
        }
      />
      <div className="text-sm text-text-secondary">
        {t('savedLayout')}:{' '}
        <output data-testid="catalog-queue-saved">
          {messages.map(message => message.id).join(' / ')}
        </output>
      </div>
      <output data-testid="catalog-queue-action">{result}</output>
    </div>
  )
}
export const MixedOwnership: Story = { render: () => <Example /> }
export const Paused: Story = { render: () => <Example paused /> }
export const Readonly: Story = { render: () => <Example readonly /> }
