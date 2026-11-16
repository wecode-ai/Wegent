import type { RequestUserInputPayload, RuntimeTranscriptResponse } from '@wegent/chat-core/runtime'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'

export const interactionTask: RuntimeTaskReminderItem = {
  key: 'device\0review',
  address: { deviceId: 'device', taskId: 'review', runtime: 'codex', workspacePath: '/workspace' },
  task: {
    taskId: 'review',
    title: 'Order review',
    runtime: 'codex',
    workspacePath: '/workspace',
    interactionStatus: 'awaitingUserReply',
    updatedAt: '2026-10-30T00:00:00Z',
  },
  workspace: { deviceId: 'device', available: true, workspacePath: '/workspace', tasks: [] },
  projectName: 'Orders',
}

export const interactionQuestion: RequestUserInputPayload = {
  kind: 'request_user_input',
  delivery: 'async',
  itemId: 'compatibility-choice',
  questions: [
    {
      id: 'compatibility',
      question: 'Keep existing customer behavior?',
      is_other: true,
      options: [
        { label: 'Keep old behavior', value: 'keep' },
        { label: 'Use new behavior', value: 'replace' },
      ],
    },
  ],
}

export function interactionTranscript(
  payload = interactionQuestion,
  turnId = 'turn-1'
): RuntimeTranscriptResponse {
  return {
    runtime: 'codex',
    workspacePath: '/workspace',
    running: false,
    turns: [],
    messages: [
      {
        id: `message-${turnId}`,
        subtaskId: turnId,
        role: 'assistant',
        content: 'Existing customers would otherwise change configuration.',
        turnId,
        status: 'done',
        blocks: [
          {
            id: `block-${turnId}`,
            type: 'tool',
            tool_name: 'request_user_input_async',
            status: 'done',
            render_payload: payload,
          },
        ],
      },
    ],
  }
}
