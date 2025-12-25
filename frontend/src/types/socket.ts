// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Socket.IO event types and payload definitions
 */

// ============================================================
// Client -> Server Events
// ============================================================

export const ClientEvents = {
  CHAT_SEND: 'chat:send',
  CHAT_CANCEL: 'chat:cancel',
  CHAT_RESUME: 'chat:resume',
  CHAT_RETRY: 'chat:retry',
  TASK_JOIN: 'task:join',
  TASK_LEAVE: 'task:leave',
  HISTORY_SYNC: 'history:sync',
} as const;

// ============================================================
// Server -> Client Events
// ============================================================

export const ServerEvents = {
  // Chat streaming events (to task room)
  CHAT_START: 'chat:start',
  CHAT_CHUNK: 'chat:chunk',
  CHAT_DONE: 'chat:done',
  CHAT_ERROR: 'chat:error',
  CHAT_CANCELLED: 'chat:cancelled',

  // Non-streaming messages (to task room, exclude sender)
  CHAT_MESSAGE: 'chat:message',
  CHAT_BOT_COMPLETE: 'chat:bot_complete',
  CHAT_SYSTEM: 'chat:system',

  // Task list events (to user room)
  TASK_CREATED: 'task:created',
  TASK_DELETED: 'task:deleted',
  TASK_RENAMED: 'task:renamed',
  TASK_STATUS: 'task:status',
  TASK_SHARED: 'task:shared',
  TASK_INVITED: 'task:invited', // User invited to group chat
  UNREAD_COUNT: 'unread:count',
} as const;

// ============================================================
// Client -> Server Payloads
// ============================================================

export interface ChatSendPayload {
  task_id?: number;
  team_id: number;
  message: string;
  title?: string;
  attachment_id?: number; // Single attachment (deprecated, use attachment_ids)
  attachment_ids?: number[]; // Multiple attachments support
  enable_deep_thinking?: boolean;
  enable_web_search?: boolean;
  search_engine?: string;
  enable_clarification?: boolean;
  force_override_bot_model?: string;
  force_override_bot_model_type?: string;
  is_group_chat?: boolean;
  contexts?: Array<{
    type: string;
    data: Record<string, unknown>;
  }>;
  // Repository info for code tasks
  git_url?: string;
  git_repo?: string;
  git_repo_id?: number;
  git_domain?: string;
  branch_name?: string;
  task_type?: 'chat' | 'code';
}

export interface ChatCancelPayload {
  subtask_id: number;
  partial_content?: string;
}

export interface ChatResumePayload {
  task_id: number;
  subtask_id: number;
  offset: number;
}

export interface ChatRetryPayload {
  task_id: number;
  subtask_id: number;
}

export interface TaskJoinPayload {
  task_id: number;
}

export interface TaskLeavePayload {
  task_id: number;
}

export interface HistorySyncPayload {
  task_id: number;
  after_message_id: number;
}

// ============================================================
// Server -> Client Payloads
// ============================================================

export interface SourceReference {
  /** Source index number (e.g., 1, 2, 3) */
  index: number;
  /** Document title/filename */
  title: string;
  /** Knowledge base ID */
  kb_id: number;
}

export interface ChatStartPayload {
  task_id: number;
  subtask_id: number;
  bot_name?: string;
  shell_type?: string; // Shell type for frontend display (Chat, ClaudeCode, Agno, etc.)
}

export interface ChatChunkPayload {
  subtask_id: number;
  content: string;
  offset: number;
  /** Full result data for executor tasks (contains thinking, workbench) */
  result?: {
    value?: string;
    thinking?: unknown[];
    workbench?: Record<string, unknown>;
    sources?: SourceReference[];
  };
  /** Knowledge base source references (for RAG citations) */
  sources?: SourceReference[];
}

export interface ChatDonePayload {
  task_id?: number;
  subtask_id: number;
  offset: number;
  result: Record<string, unknown>;
  /** Message ID for ordering (primary sort key) */
  message_id?: number;
  /** Knowledge base source references (for RAG citations) */
  sources?: SourceReference[];
}

export interface ChatErrorPayload {
  subtask_id: number;
  error: string;
  type?: string;
  /** Message ID for ordering (primary sort key) */
  message_id?: number;
}

export interface ChatCancelledPayload {
  task_id: number;
  subtask_id: number;
}

export interface ChatMessageAttachment {
  id: number;
  original_filename: string;
  file_extension: string;
  file_size: number;
  mime_type: string;
  status?: string;
}

export interface ChatMessagePayload {
  subtask_id: number;
  task_id: number;
  /** Message ID for ordering (primary sort key) */
  message_id: number;
  role: string;
  content: string;
  sender: {
    user_id: number;
    user_name: string;
    avatar?: string;
  };
  created_at: string;
  /** Single attachment (for backward compatibility) */
  attachment?: ChatMessageAttachment;
  /** Multiple attachments */
  attachments?: ChatMessageAttachment[];
}

export interface ChatBotCompletePayload {
  subtask_id: number;
  task_id: number;
  content: string;
  result: Record<string, unknown>;
  created_at?: string;
}

export interface ChatSystemPayload {
  task_id: number;
  type: string;
  content: string;
  data?: Record<string, unknown>;
}

export interface TaskCreatedPayload {
  task_id: number;
  title: string;
  team_id: number;
  team_name: string;
  created_at: string;
}

export interface TaskDeletedPayload {
  task_id: number;
}

export interface TaskRenamedPayload {
  task_id: number;
  title: string;
}

export interface TaskStatusPayload {
  task_id: number;
  status: string;
  progress?: number;
  completed_at?: string;
}

export interface TaskSharedPayload {
  task_id: number;
  title: string;
  shared_by: {
    user_id: number;
    user_name: string;
  };
}

export interface TaskInvitedPayload {
  task_id: number;
  title: string;
  team_id: number;
  team_name: string;
  invited_by: {
    user_id: number;
    user_name: string;
  };
  is_group_chat: boolean;
  created_at: string;
}

export interface UnreadCountPayload {
  count: number;
}

// ============================================================
// ACK Responses
// ============================================================

export interface ChatSendAck {
  task_id?: number;
  subtask_id?: number;
  message_id?: number; // Message ID for the user's subtask
  error?: string;
}

export interface TaskJoinAck {
  streaming?: {
    subtask_id: number;
    offset: number;
    cached_content: string;
  };
  error?: string;
}

export interface HistorySyncAck {
  messages: Array<{
    subtask_id: number;
    message_id: number;
    role: string;
    content: string;
    status: string;
    created_at: string | null;
  }>;
  error?: string;
}

export interface GenericAck {
  success: boolean;
  error?: string;
}
