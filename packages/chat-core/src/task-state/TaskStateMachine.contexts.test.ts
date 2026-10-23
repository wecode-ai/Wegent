// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest'
import { TaskStateMachine } from '..'

const artifact = {
  id: 9,
  context_type: 'remote_workspace_artifact',
  name: 'report.txt',
  status: 'ready',
  remote_task_id: 42,
  remote_path: 'outputs/report.txt',
  file_size: 32,
}

function createMachine(): TaskStateMachine {
  return new TaskStateMachine(42, {
    joinTask: vi.fn().mockResolvedValue({ subtasks: [] }),
    isConnected: () => true,
  })
}

describe('TaskStateMachine completion contexts', () => {
  it.each([true, false])('applies contexts when a stream exists: %s', hasStream => {
    const machine = createMachine()
    if (hasStream) machine.handleChatStart(7, 'ClaudeCode', 1)

    machine.handleChatDone(7, 'Done', undefined, 1, undefined, false, undefined, [artifact])

    expect(machine.getState().messages.get('ai-7')).toMatchObject({
      status: 'completed',
      content: 'Done',
      contexts: [artifact],
    })
  })

  it('preserves contexts when a replay omits the snapshot and replaces explicit snapshots', () => {
    const machine = createMachine()
    machine.handleChatStart(7)
    machine.handleChatDone(7, 'Done', undefined, 1, undefined, false, undefined, [artifact])
    machine.handleChatDone(7, 'Done')
    expect(machine.getState().messages.get('ai-7')?.contexts).toEqual([artifact])

    const updated = { ...artifact, file_size: 64 }
    machine.handleChatDone(7, 'Done', undefined, 1, undefined, false, undefined, [updated])
    expect(machine.getState().messages.get('ai-7')?.contexts).toEqual([updated])

    machine.handleChatDone(7, 'Done', undefined, 1, undefined, false, undefined, [])
    expect(machine.getState().messages.get('ai-7')?.contexts).toEqual([])
  })

  it('does not attach historical contexts to the current stream', () => {
    const machine = createMachine()
    machine.handleChatStart(7)
    machine.handleChatStart(8)

    machine.handleChatDone(7, 'Done', undefined, 1, undefined, false, undefined, [artifact])

    expect(machine.getState().messages.get('ai-7')?.contexts).toEqual([artifact])
    expect(machine.getState().messages.get('ai-8')?.contexts).toBeUndefined()
    expect(machine.getState().runtime.activeStreamSubtaskId).toBe(8)
  })
})
