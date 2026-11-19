import { ConversationQueuePanel } from '../conversation/ConversationQueuePanel'
import { createCollaborationTranslator } from '../i18n'
import {
  reorderLocalQueuedMessages,
  type QueuedWorkbenchMessage,
} from '@wegent/chat-core/conversation-queue'
import { createAgent } from '@ui-sdk/react/agent'
// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SortableRoot, SortableItem, SortableHandle } from './Sortable'
const sortableAgent = createAgent()

import { BoardLayoutEditor } from '../project-manage/BoardLayoutEditor'
import type { ProjectManageStatus } from '../project-manage/types'

it('keeps board order uncommitted until drop, preserves cancel, and retains the status objects', () => {
  const original: ProjectManageStatus[] = [
    { id: 'one', name: 'One', color: 'gray' },
    { id: 'two', name: 'Two', color: 'blue' },
    { id: 'three', name: 'Three', color: 'green' },
  ]
  const changed = vi.fn()
  function Settings() {
    const [statuses, setStatuses] = useState(original)
    return (
      <BoardLayoutEditor
        statuses={statuses}
        display={{ showAssignee: true, showPriority: true, showTags: true, showDate: true }}
        statusBusy={false}
        displayBusy={false}
        canEditStatuses
        onStatusesChange={next => {
          changed(next)
          setStatuses(next)
        }}
        onDisplayChange={() => {}}
      />
    )
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('__UI_SDK_STRICT__', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<Settings />))
  const view = {
    container,
    getByTestId: (id: string) => {
      const element = container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
      if (!element) throw new Error(`Missing ${id}`)
      return element
    },
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
  const order = () =>
    [...view.container.querySelectorAll('[data-slot="sortable-item"]')].map(item =>
      item.getAttribute('data-testid')
    )
  const key = (value: string) =>
    act(() => {
      view
        .getByTestId('cloud-board-status-drag-one')
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
        )
    })
  try {
    act(() => view.getByTestId('cloud-board-status-drag-one').focus())
    key(' ')
    key('ArrowRight')
    expect(changed).not.toHaveBeenCalled()
    expect(order()).toEqual([
      'cloud-board-status-two',
      'cloud-board-status-one',
      'cloud-board-status-three',
    ])
    key('Escape')
    expect(order()).toEqual(original.map(status => `cloud-board-status-${status.id}`))
    expect(changed).not.toHaveBeenCalled()
    key(' ')
    key('End')
    key(' ')
    expect(changed).toHaveBeenCalledExactlyOnceWith([original[1], original[2], original[0]])
    expect(document.activeElement).toBe(view.getByTestId('cloud-board-status-drag-one'))
  } finally {
    view.unmount()
    vi.unstubAllGlobals()
  }
})

it('reports source identity for persistence and cancels the external move lifecycle on unmount', async () => {
  const changed = vi.fn()
  const started = vi.fn()
  const ended = vi.fn()
  function List() {
    const [value, setValue] = useState(['a', 'b'])
    return (
      <SortableRoot
        value={value}
        aria-label="Order"
        onValueChange={(next, details) => {
          changed(next, details)
          setValue(next)
        }}
        onMoveStart={started}
        onMoveEnd={ended}
      >
        {state =>
          (state.moving?.order ?? state.value).map(id => (
            <SortableItem key={id} value={id} label={id}>
              <SortableHandle data-testid={`move-${id}`}>{id}</SortableHandle>
            </SortableItem>
          ))
        }
      </SortableRoot>
    )
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('__UI_SDK_STRICT__', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let mounted = true
  try {
    act(() => root.render(<List />))
    const entry = sortableAgent.snapshot().find(item => item.label === 'Order' && !item.offPage)
    expect(entry?.items?.map(item => item.value)).toEqual(['a', 'b'])
    const first = entry!.items![0].value
    const result = await sortableAgent.act({
      steps: [{ ref: entry!.ref, action: 'move', args: [first, 1] }],
    })
    await act(async () => {})
    expect(result.ok, result.error?.message).toBe(true)
    expect(
      [...container.querySelectorAll('[data-slot="sortable-handle"]')].map(item =>
        item.getAttribute('data-testid')
      )
    ).toEqual(['move-b', 'move-a'])
    expect(changed).toHaveBeenLastCalledWith(
      ['b', 'a'],
      expect.objectContaining({ source: 'agent', key: 'a' })
    )
    const restore = await sortableAgent.act({
      steps: [{ ref: entry!.ref, action: 'move', args: [first, 0] }],
    })
    await act(async () => {})
    expect(restore.ok, restore.error?.message).toBe(true)
    expect(
      [...container.querySelectorAll('[data-slot="sortable-handle"]')].map(item =>
        item.getAttribute('data-testid')
      )
    ).toEqual(['move-a', 'move-b'])
    changed.mockClear()
    const key = (id: string, value: string) =>
      act(() => {
        container
          .querySelector(`[data-testid="move-${id}"]`)!
          .dispatchEvent(
            new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
          )
      })
    key('a', ' ')
    key('a', 'ArrowDown')
    key('a', ' ')
    expect(started).toHaveBeenCalledExactlyOnceWith('a', expect.any(KeyboardEvent))
    expect(changed).toHaveBeenCalledExactlyOnceWith(
      ['b', 'a'],
      expect.objectContaining({ key: 'a', fromIndex: 0, toIndex: 1, reason: 'move-key' })
    )
    expect(ended).toHaveBeenCalledExactlyOnceWith('a', true, expect.any(KeyboardEvent))
    act(() => container.querySelector<HTMLElement>('[data-testid="move-b"]')!.focus())
    key('b', ' ')
    expect(started).toHaveBeenLastCalledWith('b', expect.any(KeyboardEvent))
    await act(async () => root.unmount())
    mounted = false
    expect(ended.mock.lastCall?.slice(0, 2)).toEqual(['b', false])
    expect(ended.mock.lastCall?.[2]).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(1)
  } finally {
    if (mounted) act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it('keeps runtime-owned and in-flight queue slots fixed while committing a local message move', async () => {
  const initial: QueuedWorkbenchMessage[] = [
    { id: 'sending', content: 'Sending', status: 'sending', createdAt: '' },
    { id: 'one', content: 'First local', status: 'queued', createdAt: '' },
    { id: 'server', content: 'Server queue', status: 'queued', runtimeQueued: true, createdAt: '' },
    {
      id: 'hidden',
      content: 'Awaiting acceptance',
      status: 'queued',
      awaitingGuidanceAcceptance: true,
      createdAt: '',
    },
    { id: 'two', content: 'Second local', status: 'queued', createdAt: '' },
    { id: 'failed', content: 'Failed', status: 'failed', createdAt: '' },
  ]
  function Queue() {
    const [messages, setMessages] = useState(initial)
    return (
      <>
        <ConversationQueuePanel
          translate={createCollaborationTranslator('en')}
          queuedMessages={messages}
          guidanceMessages={[
            { id: 'guidance', content: 'Guidance', status: 'queued', createdAt: '' },
          ]}
          onReorderQueuedMessages={(source, target) =>
            setMessages(current => reorderLocalQueuedMessages(current, source, target))
          }
        />
        <output>{messages.map(message => message.id).join(',')}</output>
      </>
    )
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('__UI_SDK_STRICT__', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Queue />))
    const order = () =>
      [...container.querySelectorAll('[data-testid^="conversation-queue-row-"]')].map(item =>
        item.getAttribute('data-testid')!.replace('conversation-queue-row-', '')
      )
    const handle = container.querySelector<HTMLElement>('[data-testid="queue-drag-handle-one"]')!
    const key = (value: string) =>
      act(() => {
        handle.dispatchEvent(
          new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
        )
      })
    act(() => handle.focus())
    key(' ')
    key('ArrowDown')
    expect(order()).toEqual(['guidance', 'sending', 'two', 'server', 'one', 'failed'])
    expect(container.querySelector('output')!.textContent).toBe(
      'sending,one,server,hidden,two,failed'
    )
    key(' ')
    expect(container.querySelector('output')!.textContent).toBe(
      'sending,two,server,hidden,one,failed'
    )
    expect(order()).toEqual(['guidance', 'sending', 'two', 'server', 'one', 'failed'])
    expect(container.querySelector('[data-testid="queue-drag-handle-server"]')).toBeNull()
    expect(container.querySelector('[data-testid="queue-drag-handle-sending"]')).toBeNull()
    expect(container.querySelector('[data-testid="queue-drag-handle-failed"]')).toBeNull()
    expect(document.activeElement).toBe(handle)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
