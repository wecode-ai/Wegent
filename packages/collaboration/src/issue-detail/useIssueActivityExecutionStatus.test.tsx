// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectChatMessage } from '@wegent/chat-core'
import type {
  RuntimeConversationClient,
  RuntimeConversationHandlers,
} from '@wegent/chat-core/runtime-conversation-client'
import type { RuntimeTranscriptResponse } from '@wegent/chat-core/runtime'
import { RuntimeConversationScope } from '../conversation/RuntimeConversationScope'
import { useRuntimeConversationSession } from '../conversation/useRuntimeConversationSession'
import { useIssueActivityExecutionStatus } from './useIssueActivityExecutionStatus'

const address = { deviceId: 'device-1', taskId: 'task-1' }
const message = {
  messageId: 'run-1',
  sender: { type: 'agent' },
  metadata: { run_status: 'running' },
  runtimeAddress: address,
} as ProjectChatMessage

function transcript({
  identified = true,
  partial = false,
  empty = false,
  running = true,
} = {}): RuntimeTranscriptResponse {
  return {
    taskId: address.taskId,
    runtime: 'codex',
    workspacePath: '/project',
    running,
    hasMoreBefore: partial,
    rangeStart: partial ? 10 : 0,
    rangeEnd: empty ? 0 : partial ? 11 : 1,
    messages: [],
    turns: empty
      ? []
      : [
          {
            id: 'turn-1',
            status: running ? 'streaming' : 'completed',
            items: [
              {
                id: identified ? message.messageId : 'legacy-request',
                type: 'user_message',
                message: {
                  id: identified ? message.messageId : 'legacy-request',
                  role: 'user',
                  content: 'Request',
                  createdAt: '2026-09-17T00:00:00Z',
                },
              },
              {
                id: 'answer',
                type: 'assistant_text',
                content: 'Answer',
                createdAt: '2026-09-17T00:00:00Z',
              },
            ],
          },
        ],
  }
}

describe('shared Issue execution facts', () => {
  let root: Root
  let container: HTMLDivElement
  let handlers: RuntimeConversationHandlers
  let runtime: RuntimeConversationClient
  let unsubscribe: ReturnType<typeof vi.fn>
  let viewer: ReturnType<typeof useRuntimeConversationSession> | undefined
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    unsubscribe = vi.fn()
    runtime = {
      subscribe: vi.fn(async (_address, incoming) => {
        handlers = incoming
        return unsubscribe
      }),
      getTranscript: vi.fn().mockResolvedValue(transcript()),
      cancel: vi.fn(),
      dispose: vi.fn(),
    }
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  function Activity({
    selected = message,
    single = true,
  }: {
    selected?: ProjectChatMessage
    single?: boolean
  }) {
    const { status } = useIssueActivityExecutionStatus(selected, single)
    return <output data-testid="activity">{status ?? 'unverified'}</output>
  }
  function Viewer({
    selected = message,
    single = true,
  }: {
    selected?: ProjectChatMessage
    single?: boolean
  }) {
    viewer = useRuntimeConversationSession(runtime, {
      ...selected.runtimeAddress!,
    })
    const { status } = useIssueActivityExecutionStatus(selected, single, viewer.state)
    return <output data-testid="viewer">{status ?? 'unverified'}</output>
  }
  async function render({
    open = false,
    issue = 'issue-1',
    selected = message,
    single = true,
    strict = false,
  } = {}) {
    const view = (
      <RuntimeConversationScope key={issue} runtime={runtime}>
        <Activity selected={selected} single={single} />
        {open && <Viewer selected={selected} single={single} />}
      </RuntimeConversationScope>
    )
    await act(async () => root.render(strict ? <StrictMode>{view}</StrictMode> : view))
  }
  const status = (id = 'activity') => container.querySelector(`[data-testid="${id}"]`)?.textContent

  it.each([true, false])(
    'shares facts and retains the original turn after closing (identified=%s)',
    async identified => {
      vi.mocked(runtime.getTranscript).mockResolvedValue(transcript({ identified }))
      await render()
      expect(runtime.getTranscript).not.toHaveBeenCalled()
      expect(runtime.subscribe).not.toHaveBeenCalled()
      await render({ open: true })
      expect(status()).toBe('streaming')
      expect(status('viewer')).toBe('streaming')
      expect(runtime.getTranscript).toHaveBeenCalledTimes(1)
      expect(runtime.subscribe).toHaveBeenCalledTimes(1)
      await render()
      expect(unsubscribe).not.toHaveBeenCalled()
      await act(async () =>
        handlers.onMessageAction?.({
          type: 'assistant_done',
          subtaskId: 'turn-1',
          itemId: 'answer',
          content: 'Final',
        })
      )
      expect(status()).toBe('done')
      await act(async () =>
        handlers.onMessageAction?.({
          type: 'assistant_started',
          subtaskId: 'turn-2',
        })
      )
      expect(status()).toBe('done')
      expect(message.metadata.run_status).toBe('running')
      vi.mocked(runtime.getTranscript).mockRejectedValueOnce(new Error('device offline'))
      await render({ open: true })
      expect(status()).toBe('done')
      expect(status('viewer')).toBe('done')
      expect(viewer?.state.messages.length).toBeGreaterThan(0)
      expect(viewer?.state.error).toBe('device offline')
      expect(runtime.subscribe).toHaveBeenCalledTimes(1)
      await act(async () => viewer?.session.reload())
      expect(viewer?.state.error).toBeNull()
      await render({ issue: 'issue-2' })
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      expect(status()).toBe('unverified')
    }
  )

  it.each([
    { partial: true, single: true },
    { partial: false, single: false },
  ])('does not guess legacy identity (%j)', async ({ partial, single }) => {
    vi.mocked(runtime.getTranscript).mockResolvedValue(
      transcript({ identified: false, partial, running: false })
    )
    await render({ open: true, single })
    expect(status()).toBe('unverified')
    expect(status('viewer')).toBe('unverified')
  })

  it('reports unknown for verified idle empty history and recovers on retry', async () => {
    vi.mocked(runtime.getTranscript).mockResolvedValueOnce(
      transcript({ running: false, empty: true })
    )
    await render({ open: true })
    expect(status()).toBe('unknown')
    expect(status('viewer')).toBe('unknown')
    await act(async () => viewer?.session.reload())
    expect(status()).toBe('streaming')
  })

  it('isolates subagents and devices with the same task id', async () => {
    await render({ open: true })
    await render({
      selected: {
        ...message,
        runtimeAddress: { ...address, deviceId: 'other-device' },
      },
    })
    expect(status()).toBe('unverified')
    expect(runtime.subscribe).toHaveBeenCalledTimes(1)
    await render({
      selected: { ...message, metadata: { kind: 'task_ai_subagent' } },
    })
    expect(status()).toBe('unverified')
  })

  it('releases a late subscription after scope disposal', async () => {
    let finish: ((value: () => void) => void) | undefined
    vi.mocked(runtime.subscribe).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    await render({ open: true })
    await render({ issue: 'new-issue' })
    await act(async () => finish?.(unsubscribe))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(runtime.getTranscript).not.toHaveBeenCalled()
  })

  it('survives StrictMode cleanup without losing live updates', async () => {
    await render({ open: true, strict: true })
    expect(status()).toBe('streaming')
    await act(async () =>
      handlers.onMessageAction?.({
        type: 'assistant_done',
        subtaskId: 'turn-1',
        itemId: 'answer',
        content: 'Final',
      })
    )
    expect(status()).toBe('done')
  })
})
