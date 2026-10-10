import { describe, expect, it, vi } from 'vitest'
import { TaskStateMachine } from '..'
import type { MessageBlock } from '../message-blocks'

describe('Claude text segments', () => {
  it.each([false, true])(
    'preserves text and order through completion and recovery (split chunks: %s)',
    async (splitChunks) => {
      const machine = new TaskStateMachine(1, {
        joinTask: vi.fn(),
        isConnected: () => true,
      })
      const intro = 'Starting three jobs. \u{1f600}\n'
      const progress = 'Job one finished; two jobs remain.\n'
      const summary = '| Job | Result |\n| --- | --- |\n| one | done |\n'
      const thinking: MessageBlock = {
        id: 'thinking',
        type: 'thinking',
        content: 'Synthetic reasoning',
        status: 'done',
      }
      const tool: MessageBlock = {
        id: 'tool',
        type: 'tool',
        tool_use_id: 'tool',
        tool_name: 'Bash',
        status: 'done',
      }
      machine.handleChatStart(2, 'Claude', 1)
      machine.handleChatChunk(2, '', { blocks: [thinking] })
      machine.handleChatChunk(2, intro, undefined, undefined, undefined, 0)
      machine.handleChatChunk(2, '', { blocks: [tool] })
      let offset = Array.from(intro).length
      for (const segment of [progress, summary]) {
        const chunks = splitChunks
          ? [segment.slice(0, 7), segment.slice(7)]
          : [segment]
        for (const chunk of chunks) {
          machine.handleChatChunk(
            2,
            chunk,
            undefined,
            undefined,
            undefined,
            offset,
          )
          offset += Array.from(chunk).length
        }
      }
      const project = (blocks: MessageBlock[] = []) =>
        blocks.map((block) => ({
          type: block.type,
          content:
            block.type === 'text' || block.type === 'thinking'
              ? block.content
              : undefined,
          toolUseId: block.type === 'tool' ? block.tool_use_id : undefined,
        }))
      const streaming = machine.getState().messages.get('ai-2')!
      expect(streaming.content).toBe(intro + progress + summary)

      const completed: MessageBlock[] = [
        thinking,
        { id: 'backend-intro', type: 'text', content: intro, status: 'done' },
        tool,
        {
          id: 'backend-result',
          type: 'text',
          content: progress + summary,
          status: 'done',
        },
      ]
      expect(project(streaming.result?.blocks)).toEqual(project(completed))
      machine.handleChatDone(2, intro + progress + summary, {
        blocks: completed,
      })
      const message = machine.getState().messages.get('ai-2')!
      expect(message.content).toBe(intro + progress + summary)
      expect(project(message.result?.blocks)).toEqual(project(completed))
      expect(
        message.result?.blocks
          ?.filter((b) => b.type === 'text')
          .map((b) => b.content)
          .join(''),
      ).toBe(intro + progress + summary)

      const refreshed = new TaskStateMachine(1, {
        isConnected: () => true,
        joinTask: vi.fn().mockResolvedValue({
          subtasks: [
            {
              id: 2,
              role: 'TEAM',
              message_id: 1,
              prompt: '',
              status: 'COMPLETED',
              result: { value: intro + progress + summary, blocks: completed },
              created_at: '2026-01-01T00:00:00.000Z',
              bots: [],
            },
          ],
        }),
      })
      refreshed.loadTask({
        id: 1,
        status: 'COMPLETED',
        updated_at: '2026-01-01T00:00:00.000Z',
      })
      await refreshed.recover({ force: true })
      const recovered = refreshed.getState().messages.get('ai-2')!
      expect(recovered.content).toBe(message.content)
      expect(project(recovered.result?.blocks)).toEqual(
        project(message.result?.blocks),
      )
    },
  )
})
