export type RuntimeName = "codex" | "claude_code" | "claude" | string;

export interface RuntimeTaskAddress {
  deviceId: string;
  taskId: string;
  runtime?: RuntimeName;
  threadId?: string | null;
  workspacePath?: string | null;
  workspaceKind?: "workspace" | "worktree" | "chat" | string | null;
  worktreeId?: string | null;
  runtimeHandle?: Record<string, unknown> | null;
}

export interface RuntimeMessageSource {
  source: "im" | "manual" | string;
  external_id?: string | null;
  channel_type?: string | null;
  channel_label?: string | null;
  channel_id?: number | null;
  conversation_id?: string | null;
  sender_id?: string | null;
  message_id?: string | null;
}

export interface RuntimeMessagePresentationReference {
  start: number;
  end: number;
  href: string;
}

export interface NormalizedRuntimeMessage {
  id: string;
  clientUserMessageId?: string | null;
  client_user_message_id?: string | null;
  role: "user" | "assistant" | "system" | string;
  content: string;
  presentationReferences?: RuntimeMessagePresentationReference[] | null;
  presentation_references?: RuntimeMessagePresentationReference[] | null;
  contentTruncated?: boolean | null;
  content_truncated?: boolean | null;
  contentOriginalChars?: number | null;
  content_original_chars?: number | null;
  messageIndex?: number | null;
  message_index?: number | null;
  subtaskId?: string | number | null;
  turnId?: string | null;
  turn_id?: string | null;
  status?: string | null;
  error?: string | null;
  errorType?: string | null;
  error_type?: string | null;
  createdAt?: string | null;
  completedAt?: string | number | null;
  completed_at?: string | number | null;
  stoppedNotice?: boolean | null;
  stopped_notice?: boolean | null;
  runtimeGoalRequest?: boolean | null;
  runtime_goal_request?: boolean | null;
  source?: RuntimeMessageSource | null;
  attachments?: Attachment[];
  blocks?: ChatBlock[];
  fileChanges?: TurnFileChangesSummary | null;
  file_changes?: TurnFileChangesSummary | null;
  references?: CodexReference[] | null;
  memoryCitations?: CodexMemoryCitation[] | null;
  memory_citations?: CodexMemoryCitation[] | null;
  memoryCitation?: CodexMemoryCitation | null;
  memory_citation?: CodexMemoryCitation | null;
}

export interface RuntimeTurnNavigationItem {
  id: string;
  turnId?: string | null;
  turnIndex: number;
  messageIndex: number;
  cursor?: string | null;
  promptPreview: string;
  responsePreview?: string | null;
}

export interface CodexReference {
  path: string;
  title?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
}

export interface CodexMemoryCitationEntry {
  path: string;
  lineStart?: number | null;
  line_start?: number | null;
  lineEnd?: number | null;
  line_end?: number | null;
  note?: string | null;
}

export interface CodexMemoryCitation {
  entries?: CodexMemoryCitationEntry[];
  rolloutIds?: string[];
  rollout_ids?: string[];
  threadIds?: string[];
  thread_ids?: string[];
}

export interface RuntimeTranscriptResponse {
  historyUnavailable?: boolean;
  taskId?: string;
  workspacePath: string;
  runtime: RuntimeName;
  running?: boolean;
  title?: string | null;
  messages: NormalizedRuntimeMessage[];
  turns: RuntimeTranscriptTurn[];
  contextUsage?: RuntimeContextUsage | null;
  fullContent?: boolean;
  turnNavigation?: RuntimeTurnNavigationItem[];
  rangeStart?: number | null;
  rangeEnd?: number | null;
  hasMoreBefore?: boolean;
  beforeCursor?: string | null;
  hasMoreAfter?: boolean;
  afterCursor?: string | null;
  parseError?: string | null;
}

export interface RuntimeTranscriptTurn {
  id: string;
  items: RuntimeTranscriptTurnItem[];
  itemMerge?: "prepend";
  messageIndex?: number | null;
  status?: string;
  runtimeStatus?: string | null;
  completedAt?: string | number | null;
  error?: string | null;
  errorType?: string | null;
  stoppedNotice?: boolean | null;
  fileChanges?: TurnFileChangesSummary | null;
  references?: CodexReference[] | null;
  memoryCitations?: CodexMemoryCitation[] | null;
}

export type RuntimeTranscriptTurnItem =
  | {
      id: string;
      type: "user_message";
      message: NormalizedRuntimeMessage;
    }
  | {
      id: string;
      type: "assistant_text";
      content: string;
      createdAt?: string | number | null;
    }
  | {
      id: string;
      type: "block";
      block: ChatBlock;
    };

export interface RuntimeTranscriptRequest extends RuntimeTaskAddress {
  limit?: number;
  beforeCursor?: string | null;
  afterCursor?: string | null;
  refresh?: boolean;
  includeFullContent?: boolean;
  navigationOnly?: boolean;
}

export interface RuntimeTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface RuntimeContextUsage {
  total: RuntimeTokenUsageBreakdown;
  last: RuntimeTokenUsageBreakdown;
  /** Context window the reported usage is measured against, excluding the model's output budget. */
  modelContextWindow: number;
}

export type TurnFileChangesStatus =
  | "active"
  | "reverted"
  | "conflicted"
  | "artifact_missing";

export interface TurnFileChangeItem {
  old_path?: string | null;
  path: string;
  change_type: "created" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface TurnFileChangesSummary {
  version: 1;
  status: TurnFileChangesStatus;
  artifact_id: string;
  device_id: string;
  workspace_path: string;
  file_count: number;
  additions: number;
  deletions: number;
  files: TurnFileChangeItem[];
  reverted_at?: string | null;
  diff?: string;
  revertible?: boolean;
}

export type ChatBlockType =
  | "text"
  | "tool"
  | "thinking"
  | "plan"
  | "error"
  | "guidance"
  | "subagent"
  | "file_changes";

export interface ChatBlock {
  id: string;
  type: ChatBlockType;
  content?: string;
  contentTruncated?: boolean;
  contentOriginalChars?: number;
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
  tool_output_truncated?: boolean;
  tool_output_original_bytes?: number;
  parent_tool_use_id?: string;
  parentToolUseId?: string;
  agent_type?: string;
  agentType?: string;
  agent_id?: string;
  agentId?: string;
  agent_thread_id?: string;
  agentThreadId?: string;
  agent_path?: string;
  agentPath?: string;
  agent_status?: "running" | "done" | "interrupted";
  agentStatus?: "running" | "done" | "interrupted";
  title?: string;
  description?: string;
  output?: string;
  summary?: string;
  children?: ChatBlock[];
  render_payload?: unknown;
  renderPayload?: unknown;
  file_changes?: TurnFileChangesSummary;
  fileChanges?: TurnFileChangesSummary;
  status?: "generating_arguments" | "pending" | "streaming" | "done" | "error";
  timestamp?: number | string | null;
  created_at?: number | string | null;
  createdAt?: number | string | null;
  completed_at?: number | string | null;
  completedAt?: number | string | null;
}

export type AttachmentStatus = "uploading" | "parsing" | "ready" | "failed";

export interface RuntimeWorkspaceFileReference {
  device_id: string;
  workspace_path: string;
  path: string;
}

export interface Attachment {
  id: number;
  filename: string;
  file_size: number;
  mime_type: string;
  status: AttachmentStatus;
  text_length?: number | null;
  text_preview?: string | null;
  text_content?: string | null;
  error_message?: string | null;
  error_code?: string | null;
  subtask_id?: string | null;
  file_extension: string;
  created_at: string;
  local_preview_url?: string;
  local_path?: string;
  workspace_file?: RuntimeWorkspaceFileReference;
  image_width?: number;
  image_height?: number;
  ui_group_id?: string;
  ui_group_role?: "primary" | "companion";
  ui_kind?: "appshot" | "pasted-text";
}

export interface RequestUserInputResponseAnswer {
  answers: string[];
}

export interface RequestUserInputResponse {
  requestId?: number | string;
  request_id?: number | string;
  itemId?: string;
  item_id?: string;
  answers: Record<string, RequestUserInputResponseAnswer>;
}

export interface RequestUserInputOption {
  label?: string;
  description?: string;
  value?: string;
}

export interface RequestUserInputQuestion {
  id?: string;
  header?: string;
  question?: string;
  is_other?: boolean;
  isOther?: boolean;
  options?: RequestUserInputOption[];
}

export interface RequestUserInputPayload {
  kind?: string;
  request_id?: number | string;
  requestId?: number | string;
  item_id?: string;
  itemId?: string;
  interactionKind?: string;
  interaction_kind?: string;
  approvalKind?: string;
  approval_kind?: string;
  command?: string;
  cwd?: string;
  reason?: string;
  grantRoot?: string;
  grant_root?: string;
  questions?: RequestUserInputQuestion[];
  response?: RequestUserInputResponse;
  requestUserInputResponse?: RequestUserInputResponse;
  request_user_input_response?: RequestUserInputResponse;
}
