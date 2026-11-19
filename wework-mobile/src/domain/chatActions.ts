import type { ChatMessage, RequestUserInputResponse } from '@/types/runtime'

export interface RuntimeStreamEvent {
  name: string
  payload: Record<string, unknown>
}

export type ChatAction =
  | ({ type: 'optimistic-user' } & Pick<
      ChatMessage,
      'id' | 'content' | 'createdAt' | 'attachments'
    >)
  | { type: 'stream'; event: RuntimeStreamEvent }
  | { type: 'fail'; id: string; error: string }
  | { type: 'user-delivered'; id: string }
  | { type: 'user-input-response'; response: RequestUserInputResponse }
  | { type: 'user-input-cancelled'; key: string }
