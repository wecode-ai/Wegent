import { describe, expect, test } from 'vitest'
import {
  reduceRuntimeConversationTurns,
  projectRuntimeConversationTurns,
} from '@/features/workbench/runtimeConversationTurns'
import type { RuntimeConversationTurn, ToolBlock, WorkbenchMessage } from '@/types/workbench'
import { conversationTerminals } from './backgroundTerminals'

function command(): ToolBlock {
  return {
    id: 'command-1',
    subtaskId: 'turn-1',
    type: 'tool',
    toolName: 'bash',
    status: 'streaming',
    createdAt: 1,
    toolInput: { command: 'pnpm dev', cwd: '/project' },
    toolOutput: 'ready\n',
    renderPayload: { kind: 'command_execution', processId: '42', status: 'inProgress' },
  }
}

function messages(status: WorkbenchMessage['status'], block = command()): WorkbenchMessage[] {
  return [
    {
      id: 'message-1',
      role: 'assistant',
      content: 'Started',
      createdAt: '2026-10-12T00:00:00Z',
      status,
      blocks: [block],
    },
  ]
}

describe('background terminal lifecycle', () => {
  test('does not mistake a completed display segment for a finished owning turn', () => {
    const projected: WorkbenchMessage[] = [
      { ...messages('done')[0], turnId: 'turn-1' },
      { ...messages('streaming')[0], id: 'final-segment', turnId: 'turn-1', blocks: [] },
    ]
    expect(conversationTerminals(projected, 'task-1')[0].background).toBe(false)
    projected[1].status = 'done'
    expect(conversationTerminals(projected, 'task-1')[0].background).toBe(true)
  })

  test('lists running commands from finished turns and excludes the active turn and nested agents', () => {
    expect(conversationTerminals(messages('streaming'), 'task-1')[0].background).toBe(false)
    expect(conversationTerminals(messages('done'), 'task-1')[0]).toMatchObject({
      background: true,
      command: 'pnpm dev',
      cwd: '/project',
    })
    expect(
      conversationTerminals(
        messages('done', { ...command(), parentToolUseId: 'agent-1' }),
        'task-1'
      )
    ).toEqual([])
    expect(
      conversationTerminals(messages('done', { ...command(), status: 'done' }), 'task-1')[0]
        .background
    ).toBe(false)
  })

  test('keeps process state across turn completion, input, late output and exit without reopening the turn', () => {
    let turns: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        status: 'streaming',
        items: [{ id: 'command-1', type: 'block', block: command() }],
      },
    ]
    turns = reduceRuntimeConversationTurns(turns, {
      type: 'assistant_done',
      subtaskId: 'turn-1',
      content: 'Started',
    })
    expect(turns[0].status).toBe('done')
    expect(
      conversationTerminals(projectRuntimeConversationTurns(turns), 'task-1')[0].background
    ).toBe(true)
    turns = reduceRuntimeConversationTurns(turns, {
      type: 'block_updated',
      subtaskId: 'turn-1',
      blockId: 'command-1',
      updates: { renderPayload: { kind: 'command_execution', processId: '42', stdin: '' } },
    })
    turns = reduceRuntimeConversationTurns(turns, {
      type: 'block_updated',
      subtaskId: 'turn-1',
      blockId: 'command-1',
      updates: { status: 'streaming', toolOutputDelta: 'listening\n' },
    })
    expect(turns[0].status).toBe('done')
    const running = conversationTerminals(projectRuntimeConversationTurns(turns), 'task-1')[0]
    expect(running.background).toBe(true)
    expect(running.block.toolOutput).toContain('listening')
    expect(running.block.renderPayload).toMatchObject({ status: 'inProgress', processId: '42' })
    turns = reduceRuntimeConversationTurns(turns, {
      type: 'block_updated',
      subtaskId: 'turn-1',
      blockId: 'command-1',
      updates: {
        status: 'error',
        renderPayload: {
          kind: 'command_execution',
          processId: '42',
          status: 'failed',
          exitCode: 1,
        },
      },
    })
    expect(
      conversationTerminals(projectRuntimeConversationTurns(turns), 'task-1')[0].background
    ).toBe(false)
    expect(turns[0].status).toBe('done')
  })
})
