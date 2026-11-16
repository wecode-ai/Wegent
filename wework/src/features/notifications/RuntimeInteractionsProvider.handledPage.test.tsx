import { context, harness, view } from './runtimeInteractionsProvider.fixtures'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import {
  clearRuntimeConversationCacheForTests,
  replaceRuntimeConversationSnapshot,
} from '@/features/workbench/runtimeConversationCache'
import { projectRuntimePaneTranscript } from '@/features/workbench/runtimeTaskLifecycle/projection'
import {
  interactionQuestion,
  interactionTask,
  interactionTranscript,
} from './runtimeInteractions.fixtures'

afterEach(() => clearRuntimeConversationCacheForTests())

it.each(['reply', 'original-task', 'dismiss', 'dismiss-all'])(
  'clears both the selected pending entity and count after %s, including after remount',
  async path => {
    const rendered = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    fireEvent.click(screen.getByTestId('interaction-list-item'))
    expect(screen.getByTestId('original-notification-entity')).toBeInTheDocument()
    const item = context!.pending[0]
    if (path === 'reply') {
      await act(async () => expect(await context!.respond(item, 'Keep old behavior')).toBe(true))
      expect(harness.send).toHaveBeenCalledOnce()
    } else if (path === 'original-task') {
      act(() => {
        replaceRuntimeConversationSnapshot(interactionTask.address, [
          {
            id: 'turn-1',
            status: 'completed',
            items: projectRuntimePaneTranscript(
              interactionTranscript({ ...interactionQuestion, interactionStatus: 'answered' })
            ).messages[0].blocks!.map(block => ({ id: block.id, type: 'block', block })),
          },
        ])
      })
    } else {
      fireEvent.click(
        screen.getByTestId(
          path === 'dismiss-all' ? 'interactions-dismiss-all' : 'interaction-dismiss'
        )
      )
    }
    await waitFor(() => expect(context!.pending).toHaveLength(0))
    expect(context!.history).toEqual([expect.objectContaining({ id: item.id })])
    expect(screen.getByTestId('interactions-pending-count')).toHaveTextContent('0')
    expect(screen.queryByTestId('interaction-list-item')).not.toBeInTheDocument()
    expect(screen.queryByTestId('interaction-question-heading')).not.toBeInTheDocument()
    expect(screen.queryByTestId('original-notification-entity')).not.toBeInTheDocument()
    rendered.unmount()
    view()
    await waitFor(() => expect(context!.loading).toBe(false))
    expect(context!.pending).toHaveLength(0)
    expect(screen.queryByTestId('original-notification-entity')).not.toBeInTheDocument()
  }
)
