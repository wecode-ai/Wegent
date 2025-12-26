// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Thinking step structure from backend
 */
export interface ThinkingStep {
  title: string;
  next_action: string;
  details?: {
    type?: string;
    subtype?: string;
    message?: {
      id?: string;
      type?: string;
      role?: string;
      model?: string;
      content?: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: string | Record<string, unknown>;
        tool_use_id?: string;
        content?: string;
        is_error?: boolean;
      }>;
      stop_reason?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
      parent_tool_use_id?: string;
    };
    // Tool use details
    id?: string;
    name?: string;
    input?: string | Record<string, unknown>;
    // Tool result details
    tool_use_id?: string;
    content?: string;
    is_error?: boolean;
    // Result message details
    session_id?: string;
    num_turns?: number;
    duration_ms?: number;
    duration_api_ms?: number;
    total_cost_usd?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
    result?: string;
    timestamp?: string;
    created_at?: string;
    // System info details
    model?: string;
    tools?: string[];
    mcp_servers?: Array<{ name: string; status: string }>;
    permissionMode?: string;
    cwd?: string;
    // Error details
    error_message?: string;
    execution_type?: string;
    // Custom details
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
  // Legacy fields for backward compatibility
  action?: string;
  result?: string;
  reasoning?: string;
  confidence?: number;
  value?: unknown;
}

/**
 * Todo item structure
 */
export interface TodoItem {
  status: 'pending' | 'in_progress' | 'completed';
  content: string;
  activeForm?: string;
}

/**
 * MCP Server status
 */
export interface McpServer {
  name: string;
  status: 'connected' | 'disconnected' | string;
}

/**
 * Props for ThinkingDisplay component
 */
export interface ThinkingDisplayProps {
  thinking: ThinkingStep[] | null;
  taskStatus?: string;
  shellType?: string;
}

/**
 * Props for ThinkingHeader component
 */
export interface ThinkingHeaderProps {
  title: string;
  isOpen: boolean;
  isCompleted: boolean;
  isRunning: boolean;
  toolSummary?: string;
  onToggle: () => void;
}

/**
 * Props for ToolCallItem component
 */
export interface ToolCallItemProps {
  toolName: string;
  input?: Record<string, unknown>;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  itemIndex: number;
}

/**
 * Props for ToolResultItem component
 */
export interface ToolResultItemProps {
  content: string;
  isError?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  itemIndex: number;
}

/**
 * Props for TodoListDisplay component
 */
export interface TodoListDisplayProps {
  todos: TodoItem[];
}

/**
 * Props for SystemInfoDisplay component
 */
export interface SystemInfoDisplayProps {
  subtype?: string;
  model?: string;
  tools?: string[];
  mcpServers?: McpServer[];
  permissionMode?: string;
  cwd?: string;
}

/**
 * Props for ErrorDisplay component
 */
export interface ErrorDisplayProps {
  errorMessage: string;
  executionType?: string;
}

/**
 * Props for CollapsibleContent component
 */
export interface CollapsibleContentProps {
  content: string;
  maxLines?: number;
  maxLength?: number;
  uniqueId: string;
  colorClass?: string;
}

/**
 * Props for ScrollToBottom component
 */
export interface ScrollToBottomProps {
  show: boolean;
  onClick: () => void;
}

/**
 * Scroll state for thinking content
 */
export interface ScrollState {
  scrollTop: number;
  scrollHeight: number;
  isUserScrolling: boolean;
}
