// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import type { NormalizedRuntimeMessage } from '@wegent/chat-core/runtime'
import {
  runtimeMessageToWorkbenchMessage,
  runtimeTranscriptTurnsToConversationTurns,
} from '@wegent/chat-core/runtime-transcript'
import { projectRuntimeConversationTurns } from '@wegent/chat-core/runtime-conversation-turns'
import { createCollaborationTranslator } from '../i18n'
import { ConversationTranslationProvider } from './ConversationTranslation'
import { UserMessage } from './UserMessage'
import { AssistantMessage } from './AssistantMessage'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
const images = {
  identity: (image: { id?: number }) => String(image.id),
  load: vi.fn(),
  download: vi.fn(),
}
const content = '委派任务 internal-task-42 已结束(done)。Read the task and report its result.'
function message(source?: WorkbenchMessage['source']): WorkbenchMessage {
  return {
    id: 'activity',
    role: 'user',
    status: 'done',
    content,
    createdAt: '2026-11-05T09:00:00Z',
    source,
  }
}
function render(children: ReactNode, language = 'zh-CN') {
  act(() =>
    root.render(
      <ConversationTranslationProvider translate={createCollaborationTranslator(language)}>
        {children}
      </ConversationTranslationProvider>
    )
  )
}

it.each([['zh-CN'], ['en']])('hides explicit host activity in %s without user actions', locale => {
  const onStartEdit = vi.fn()
  render(
    <UserMessage
      message={message({
        source: 'stand_in_activity',
        taskId: 'internal-task-42',
      })}
      services={{ images }}
      editable
      editing
      forceExpanded
      onStartEdit={onStartEdit}
    />,
    locale
  )
  const note = container.querySelector('[data-testid="stand-in-activity-message"]')
  expect(note).toBeNull()
  expect(container.innerHTML).toBe('')
  expect(container.textContent).not.toContain('internal-task-42')
  expect(container.textContent).not.toContain('done')
  expect(container.textContent).not.toContain('Read the task')
  expect(container.querySelector('[data-testid="message-hover-region"]')).toBeNull()
  expect(container.querySelector('button, textarea, input')).toBeNull()
  expect(onStartEdit).not.toHaveBeenCalled()
})

it.each([undefined, { source: 'manual' }, { source: 'stand_in_activity_extra' }])(
  'keeps identical text as a real user bubble without an exact host source marker: %j',
  source => {
    render(<UserMessage message={message(source)} services={{ images }} editable />)
    expect(container.textContent).toContain(content)
    expect(container.querySelector('[data-testid="message-hover-region"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="stand-in-activity-message"]')).toBeNull()
  }
)

it('preserves IM source badges and the original IM message body', () => {
  render(
    <UserMessage
      message={message({
        source: 'im',
        channel_type: 'dingtalk',
        channel_label: '钉钉',
      })}
      services={{ images }}
    />
  )
  expect(container.textContent).toContain(content)
  expect(container.querySelector('[data-testid="message-source-badge"]')?.textContent).toContain(
    '钉钉'
  )
  expect(container.querySelector('[data-testid="stand-in-activity-message"]')).toBeNull()
})

it('retains the assistant business result after the host activity marker', () => {
  render(
    <>
      <UserMessage message={message({ source: 'stand_in_activity' })} services={{ images }} />
      <AssistantMessage
        message={{
          ...message(),
          id: 'business-result',
          role: 'assistant',
          content: '会议简报已完成：明天十点讨论发布计划，需确认回滚负责人。',
        }}
        devices={[]}
        imageServices={images}
      />
    </>
  )
  expect(container.textContent).not.toContain('分身主动更新')
  expect(container.textContent).toContain(
    '会议简报已完成：明天十点讨论发布计划，需确认回滚负责人。'
  )
  expect(container.textContent).not.toContain(content)
})

it('preserves the native history origin through transcript projection while hiding the internal trigger', () => {
  const nativeSnapshot: NormalizedRuntimeMessage = {
    id: 'native-activity-message',
    role: 'user',
    status: 'done',
    content,
    source: { source: 'stand_in_activity', taskId: 'internal-task-42' },
    createdAt: '2026-11-05T09:00:00Z',
  }
  const projected = runtimeMessageToWorkbenchMessage(nativeSnapshot)
  expect(projected.source).toEqual(nativeSnapshot.source)
  const [historyUser, historyResult] = projectRuntimeConversationTurns(
    runtimeTranscriptTurnsToConversationTurns([
      {
        id: 'native-history-turn',
        status: 'done',
        items: [
          {
            id: 'activity-item',
            type: 'user_message',
            message: nativeSnapshot,
          },
          {
            id: 'result-item',
            type: 'assistant_text',
            content: '会前简报已整理，并附上相关资料。',
            createdAt: nativeSnapshot.createdAt,
          },
        ],
      },
    ])
  )
  expect(historyUser.source).toEqual(nativeSnapshot.source)
  render(
    <>
      <UserMessage message={historyUser} services={{ images }} editable />
      <AssistantMessage message={historyResult} devices={[]} imageServices={images} />
    </>
  )
  expect(container.querySelector('[data-testid="stand-in-activity-message"]')).toBeNull()
  expect(container.textContent).not.toContain('internal-task-42')
  expect(container.textContent).not.toContain('done')
  expect(container.textContent).toContain('会前简报已整理，并附上相关资料。')
  expect(container.querySelectorAll('[data-testid="message-hover-region"]')).toHaveLength(1)
  expect(container.querySelector('[data-testid="user-message-content"]')).toBeNull()
  expect(projected.content).toBe(nativeSnapshot.content)
})
