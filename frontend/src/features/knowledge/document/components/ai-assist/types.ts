// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * AI Assist action types for document editing
 */
export type AIAssistAction =
  | 'rewrite'
  | 'expand'
  | 'summarize'
  | 'fix_grammar'
  | 'custom'
  | 'continue'
  | 'outline'
  | 'search'

/**
 * AI Assist operation status
 */
export type AIAssistStatus = 'idle' | 'thinking' | 'searching' | 'generating' | 'completed' | 'error'

/**
 * Position information for floating elements
 */
export interface Position {
  top: number
  left: number
}

/**
 * Text selection state in the editor
 */
export interface EditorSelection {
  /** The selected text */
  text: string
  /** Start position (character offset from document start) */
  from: number
  /** End position (character offset from document start) */
  to: number
  /** Position for floating UI elements */
  position: Position
}

/**
 * AI Assist request payload
 */
export interface AIAssistRequest {
  /** The action to perform */
  action: AIAssistAction
  /** The selected/target content */
  content: string
  /** Surrounding context (text before and after selection) */
  context?: string
  /** Custom prompt for 'custom' action */
  customPrompt?: string
  /** Knowledge base ID for searching */
  knowledgeBaseId?: number
  /** Whether to enable web search */
  enableWebSearch?: boolean
}

/**
 * AI Assist response with streaming support
 */
export interface AIAssistResponse {
  /** Response type */
  type: 'chunk' | 'done' | 'error'
  /** Generated content chunk */
  content?: string
  /** Source citations for search results */
  sources?: AIAssistSource[]
  /** Error message if type is 'error' */
  error?: string
}

/**
 * Source citation for AI-generated content
 */
export interface AIAssistSource {
  /** Source index for footnote reference */
  index: number
  /** Source title */
  title: string
  /** Source URL */
  url?: string
  /** Knowledge base ID if from KB */
  kbId?: number
  /** Document ID if from KB */
  documentId?: number
}

/**
 * Diff result for showing changes
 */
export interface DiffResult {
  /** Original text before AI processing */
  original: string
  /** AI-generated replacement text */
  replacement: string
  /** Start position in document */
  from: number
  /** End position in document */
  to: number
  /** Source citations if any */
  sources?: AIAssistSource[]
}

/**
 * AI Assist context state
 */
export interface AIAssistState {
  /** Current status */
  status: AIAssistStatus
  /** Current selection in editor */
  selection: EditorSelection | null
  /** Active diff being shown */
  activeDiff: DiffResult | null
  /** Accumulated AI response */
  accumulatedContent: string
  /** Error message if any */
  error: string | null
  /** Last action performed */
  lastAction: AIAssistAction | null
  /** Custom prompt for custom actions */
  customPrompt: string
}

/**
 * Command palette suggestion item
 */
export interface CommandSuggestion {
  /** Unique ID */
  id: string
  /** Display label */
  label: string
  /** Optional description */
  description?: string
  /** The action to perform */
  action: AIAssistAction
  /** Icon name (lucide icon) */
  icon?: string
}

/**
 * Editor ref interface for controlling the editor
 */
export interface EditorRef {
  /** Get current content */
  getContent: () => string
  /** Set content */
  setContent: (content: string) => void
  /** Get current selection */
  getSelection: () => EditorSelection | null
  /** Replace selection with new text */
  replaceSelection: (from: number, to: number, text: string) => void
  /** Insert text at cursor position */
  insertAtCursor: (text: string) => void
  /** Focus the editor */
  focus: () => void
  /** Get cursor position */
  getCursorPosition: () => number
  /** Get context around cursor (text before and after) */
  getContext: (charsBefore: number, charsAfter: number) => { before: string; after: string }
}
