// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Thinking step structure from backend
 */
export interface ThinkingStep {
  title: string
  next_action: string
  run_id?: string // Legacy: LangChain run_id
  tool_use_id?: string // NEW: Anthropic standard tool_use_id
  details?: {
    type?: string
    subtype?: string
    message?: {
      id?: string
      type?: string
      role?: string
      model?: string
      content?: Array<{
        type: string
        text?: string
        id?: string
        name?: string
        input?: string | Record<string, unknown>
        tool_use_id?: string
        content?: string
        is_error?: boolean
      }>
      stop_reason?: string
      usage?: {
        input_tokens?: number
        output_tokens?: number
      }
      parent_tool_use_id?: string
    }
    // Tool use details
    id?: string
    name?: string
    tool_name?: string
    status?: string
    input?: string | Record<string, unknown>
    // Tool result details
    tool_use_id?: string
    content?: string
    output?: unknown
    is_error?: boolean
    error?: string
    // Result message details
    session_id?: string
    num_turns?: number
    duration_ms?: number
    duration_api_ms?: number
    total_cost_usd?: number
    usage?: {
      input_tokens?: number
      output_tokens?: number
    }
    result?: string
    timestamp?: string
    created_at?: string
    // System info details
    model?: string
    tools?: string[]
    mcp_servers?: Array<{ name: string; status: string }>
    permissionMode?: string
    cwd?: string
    // Error details
    error_message?: string
    execution_type?: string
    // Custom details
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any
  }
  // Legacy fields for backward compatibility
  action?: string
  result?: string
  reasoning?: string
  confidence?: number
  value?: unknown
}

/**
 * Tool execution status
 */
export type ToolStatus = 'pending' | 'streaming' | 'invoking' | 'done' | 'error'

/**
 * Base interface for all message blocks.
 * Contains only fields common to all block types.
 */
interface BaseBlock {
  id: string // Unique block identifier
  status?: 'pending' | 'streaming' | 'done' | 'error' // Block status
  timestamp?: number // Block creation timestamp
}

/**
 * Text content block
 */
export interface TextBlock extends BaseBlock {
  type: 'text'
  content: string // Text content
}

/**
 * Tool execution block
 */
export interface ToolBlock extends BaseBlock {
  type: 'tool'
  tool_use_id: string // Tool call ID
  tool_name: string // Tool name
  display_name?: string // Display name for tool (optional)
  tool_input?: Record<string, unknown> // Tool input parameters
  tool_output?: unknown // Tool execution result
  metadata?: Record<string, unknown> // Additional metadata
}

/**
 * Thinking/reasoning block
 */
export interface ThinkingBlock extends BaseBlock {
  type: 'thinking'
  content: string // Thinking content
}

/**
 * Error block
 */
export interface ErrorBlock extends BaseBlock {
  type: 'error'
  content: string // Error message
}

/**
 * Video generation block
 */
export interface VideoBlock extends BaseBlock {
  type: 'video'
  video_url: string // Video URL
  video_thumbnail?: string | null // Base64 encoded thumbnail
  video_duration?: number | null // Video duration in seconds
  video_attachment_id?: number | null // Attachment ID for download
  video_progress?: number // Video generation progress (0-100)
  is_placeholder?: boolean // True when video is still being generated
  content?: string // Progress message
}

/**
 * Image generation block
 */
export interface ImageBlock extends BaseBlock {
  type: 'image'
  image_urls: string[] // Image URLs
  image_attachment_ids?: number[] // Attachment IDs for image downloads
  image_count: number // Number of generated images
  is_placeholder?: boolean // True when images are still being generated
  content?: string // Progress message
}

/**
 * Prompt change item for optimization block
 */
export interface PromptChangeItem {
  type: 'ghost' | 'member'
  id: number
  name: string
  field: string
  original: string
  suggested: string
  index?: number
}

/**
 * Apply action payload for prompt optimization
 */
export interface PromptOptimizationApplyAction {
  endpoint: string
  method: string
  payload: {
    team_id: number
    changes: Array<{
      type: 'ghost' | 'member'
      id?: number
      team_id?: number
      index?: number
      field?: string
      value: string
    }>
  }
}

/**
 * Prompt optimization block - for AI-suggested prompt improvements
 */
export interface PromptOptimizationBlock extends BaseBlock {
  type: 'prompt_optimization'
  changes: PromptChangeItem[]
  apply_action: PromptOptimizationApplyAction
}

/**
 * Subscription preview config
 */
export interface SubscriptionPreviewConfig {
  display_name: string
  description?: string
  trigger_type: 'cron' | 'interval' | 'one_time'
  trigger_display: string
  prompt_preview: string
  preserve_history: boolean
  history_message_count: number
  retry_count: number
  timeout_seconds: number
  expires_at?: string
}

/**
 * Subscription preview block - for subscription task preview
 */
export interface SubscriptionPreviewBlockType extends BaseBlock {
  type: 'subscription_preview'
  preview_id: string
  execution_id: string
  task_id: number
  subtask_id: number
  config: SubscriptionPreviewConfig
  created_at: string
}

/**
 * Union type of all message block types.
 * Use this for type-safe block handling with discriminated unions.
 */
export type MessageBlock =
  | TextBlock
  | ToolBlock
  | ThinkingBlock
  | ErrorBlock
  | VideoBlock
  | ImageBlock
  | PromptOptimizationBlock
  | SubscriptionPreviewBlockType

/**
 * Type guard for TextBlock
 */
export function isTextBlock(block: MessageBlock): block is TextBlock {
  return block.type === 'text'
}

/**
 * Type guard for ToolBlock
 */
export function isToolBlock(block: MessageBlock): block is ToolBlock {
  return block.type === 'tool'
}

/**
 * Type guard for VideoBlock
 */
export function isVideoBlock(block: MessageBlock): block is VideoBlock {
  return block.type === 'video'
}

/**
 * Type guard for ImageBlock
 */
export function isImageBlock(block: MessageBlock): block is ImageBlock {
  return block.type === 'image'
}

/**
 * Type guard for PromptOptimizationBlock
 */
export function isPromptOptimizationBlock(block: MessageBlock): block is PromptOptimizationBlock {
  return block.type === 'prompt_optimization'
}

/**
 * Paired tool use + tool result
 */
export interface ToolPair {
  toolUseId: string
  toolName: string
  displayName?: string // Optional display name that overrides toolName
  status: ToolStatus
  toolUse: ThinkingStep // tool_use type step
  toolResult?: ThinkingStep // tool_result type step (may be incomplete during streaming)
  startTime?: number
  endTime?: number
}

/**
 * Group of consecutive tools
 */
export interface ToolGroup {
  id: string // Unique group ID
  tools: ToolPair[]
  isComplete: boolean // All tools in group are done
}

/**
 * Props for ToolBlock component
 */
export interface ToolBlockProps {
  tool: ToolPair
  defaultExpanded?: boolean
}

/**
 * Props for ToolRenderer component
 */
export interface ToolRendererProps {
  tool: ToolPair
}

/**
 * Todo item structure
 */
export interface TodoItem {
  status: 'pending' | 'in_progress' | 'completed'
  content: string
  activeForm?: string
}

/**
 * MCP Server status
 */
export interface McpServer {
  name: string
  status: 'connected' | 'disconnected' | string
}

/**
 * Props for ThinkingDisplay component
 */
export interface ThinkingDisplayProps {
  thinking: ThinkingStep[] | null
  taskStatus?: string
  shellType?: string
}

/**
 * Props for ThinkingHeader component
 */
export interface ThinkingHeaderProps {
  title: string
  isOpen: boolean
  isCompleted: boolean
  isRunning: boolean
  toolSummary?: string
  onToggle: () => void
}

/**
 * Props for ToolCallItem component
 */
export interface ToolCallItemProps {
  toolName: string
  input?: Record<string, unknown>
  isExpanded?: boolean
  onToggleExpand?: () => void
  itemIndex: number
}

/**
 * Props for ToolResultItem component
 */
export interface ToolResultItemProps {
  content: string
  isError?: boolean
  isExpanded?: boolean
  onToggleExpand?: () => void
  itemIndex: number
}

/**
 * Props for TodoListDisplay component
 */
export interface TodoListDisplayProps {
  todos: TodoItem[]
}

/**
 * Props for SystemInfoDisplay component
 */
export interface SystemInfoDisplayProps {
  subtype?: string
  model?: string
  tools?: string[]
  mcpServers?: McpServer[]
  permissionMode?: string
  cwd?: string
}

/**
 * Props for ErrorDisplay component
 */
export interface ErrorDisplayProps {
  errorMessage: string
  executionType?: string
}

/**
 * Props for CollapsibleContent component
 */
export interface CollapsibleContentProps {
  content: string
  maxLines?: number
  maxLength?: number
  uniqueId: string
  colorClass?: string
}

/**
 * Props for ScrollToBottom component
 */
export interface ScrollToBottomProps {
  show: boolean
  onClick: () => void
}

/**
 * Scroll state for thinking content
 */
export interface ScrollState {
  scrollTop: number
  scrollHeight: number
  isUserScrolling: boolean
}
