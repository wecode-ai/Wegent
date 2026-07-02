// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  buildInteractiveFormCancellation,
  findPendingInteractiveForm,
} from '@/features/tasks/components/chat/interactiveFormPending'

describe('interactiveFormPending', () => {
  it('finds the latest interactive form when no later user message exists', () => {
    const pending = findPendingInteractiveForm([
      { id: 'user-1', type: 'user', content: 'create a skill' },
      {
        id: 'ai-2',
        type: 'ai',
        content: '',
        subtaskId: 20,
        result: {
          blocks: [
            {
              id: 'tool-1',
              type: 'tool',
              tool_name:
                'mcp__interactive_wegent-interactive-form-question__interactive_form_question',
              tool_use_id: 'tool-1',
              render_payload: {
                type: 'interactive_form_question',
                task_id: 100,
                subtask_id: 20,
                questions: [{ id: 'q1', question: 'Question?' }],
              },
            },
          ],
        },
      },
    ])

    expect(pending).toEqual({
      toolUseId: 'tool-1',
      taskId: 100,
      subtaskId: 20,
    })
  })

  it('finds pending forms emitted with the AskUserQuestion tool name', () => {
    const pending = findPendingInteractiveForm([
      {
        id: 'ai-2',
        type: 'ai',
        content: '',
        subtaskId: 20,
        result: {
          blocks: [
            {
              id: 'tool-ask-user',
              type: 'tool',
              tool_name: 'AskUserQuestion',
              tool_use_id: 'tool-ask-user',
              render_payload: {
                type: 'interactive_form_question',
                task_id: 100,
                subtask_id: 20,
                questions: [{ id: 'q1', question: 'Question?' }],
              },
            },
          ],
        },
      },
    ])

    expect(pending).toEqual({
      toolUseId: 'tool-ask-user',
      taskId: 100,
      subtaskId: 20,
    })
  })

  it('treats a later user message as resolving the form', () => {
    const pending = findPendingInteractiveForm([
      {
        id: 'ai-2',
        type: 'ai',
        content: '',
        subtaskId: 20,
        result: {
          blocks: [
            {
              id: 'tool-1',
              type: 'tool',
              tool_name: 'interactive_form_question',
              tool_use_id: 'tool-1',
              render_payload: {
                type: 'interactive_form_question',
                task_id: 100,
                subtask_id: 20,
                questions: [{ id: 'q1', question: 'Question?' }],
              },
            },
          ],
        },
      },
      { id: 'user-3', type: 'user', content: 'answered' },
    ])

    expect(pending).toBeNull()
  })

  it('builds a cancelled tool result payload for a replacement chat message', () => {
    const cancellation = buildInteractiveFormCancellation(
      {
        toolUseId: 'tool-1',
        taskId: 100,
        subtaskId: 20,
      },
      '直接创建中英翻译 skill'
    )

    expect(cancellation.message).toContain('直接创建中英翻译 skill')
    expect(cancellation.answer).toEqual({
      type: 'interactive_form_question',
      tool_use_id: 'tool-1',
      task_id: 100,
      subtask_id: 20,
      success: false,
      status: 'cancelled',
      answers: {},
      message: cancellation.message,
    })
  })
})
