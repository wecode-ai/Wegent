// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { createContext, useContext, useReducer, useCallback, useRef, type ReactNode } from 'react'
import type {
  AIAssistState,
  AIAssistAction,
  AIAssistStatus,
  EditorSelection,
  DiffResult,
  _EditorRef,
} from './types'

/**
 * Initial state for AI Assist
 */
const initialState: AIAssistState = {
  status: 'idle',
  selection: null,
  activeDiff: null,
  accumulatedContent: '',
  error: null,
  lastAction: null,
  customPrompt: '',
}

/**
 * Action types for the reducer
 */
type AIAssistReducerAction =
  | { type: 'SET_STATUS'; status: AIAssistStatus }
  | { type: 'SET_SELECTION'; selection: EditorSelection | null }
  | { type: 'SET_ACTIVE_DIFF'; diff: DiffResult | null }
  | { type: 'APPEND_CONTENT'; content: string }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_LAST_ACTION'; action: AIAssistAction | null }
  | { type: 'SET_CUSTOM_PROMPT'; prompt: string }
  | { type: 'START_OPERATION'; action: AIAssistAction }
  | { type: 'COMPLETE_OPERATION'; diff: DiffResult }
  | { type: 'CANCEL_OPERATION' }
  | { type: 'ACCEPT_DIFF' }
  | { type: 'REJECT_DIFF' }
  | { type: 'RESET' }

/**
 * Reducer for AI Assist state management
 */
function aiAssistReducer(state: AIAssistState, action: AIAssistReducerAction): AIAssistState {
  switch (action.type) {
    case 'SET_STATUS':
      return { ...state, status: action.status }

    case 'SET_SELECTION':
      return { ...state, selection: action.selection }

    case 'SET_ACTIVE_DIFF':
      return { ...state, activeDiff: action.diff }

    case 'APPEND_CONTENT':
      return { ...state, accumulatedContent: state.accumulatedContent + action.content }

    case 'SET_ERROR':
      return { ...state, error: action.error, status: action.error ? 'error' : state.status }

    case 'SET_LAST_ACTION':
      return { ...state, lastAction: action.action }

    case 'SET_CUSTOM_PROMPT':
      return { ...state, customPrompt: action.prompt }

    case 'START_OPERATION':
      return {
        ...state,
        status: 'thinking',
        lastAction: action.action,
        accumulatedContent: '',
        error: null,
        activeDiff: null,
      }

    case 'COMPLETE_OPERATION':
      return {
        ...state,
        status: 'completed',
        activeDiff: action.diff,
        accumulatedContent: '',
      }

    case 'CANCEL_OPERATION':
      return {
        ...state,
        status: 'idle',
        accumulatedContent: '',
        error: null,
        activeDiff: null,
      }

    case 'ACCEPT_DIFF':
      return {
        ...state,
        status: 'idle',
        activeDiff: null,
        selection: null,
      }

    case 'REJECT_DIFF':
      return {
        ...state,
        status: 'idle',
        activeDiff: null,
      }

    case 'RESET':
      return initialState

    default:
      return state
  }
}

/**
 * Context value interface
 */
interface AIAssistContextValue {
  /** Current state */
  state: AIAssistState
  /** Editor ref for controlling the editor */
  editorRef: React.MutableRefObject<_EditorRef | null>
  /** Set the selection state */
  setSelection: (selection: EditorSelection | null) => void
  /** Start an AI operation */
  startOperation: (action: AIAssistAction, customPrompt?: string) => void
  /** Cancel the current operation */
  cancelOperation: () => void
  /** Accept the current diff */
  acceptDiff: () => void
  /** Reject the current diff */
  rejectDiff: () => void
  /** Regenerate with the same action */
  regenerate: () => void
  /** Set custom prompt */
  setCustomPrompt: (prompt: string) => void
  /** Update status */
  setStatus: (status: AIAssistStatus) => void
  /** Append streaming content */
  appendContent: (content: string) => void
  /** Complete operation with diff */
  completeOperation: (diff: DiffResult) => void
  /** Set error */
  setError: (error: string | null) => void
  /** Reset state */
  reset: () => void
}

const AIAssistContext = createContext<AIAssistContextValue | null>(null)

/**
 * Hook to access AI Assist context
 */
export function useAIAssist(): AIAssistContextValue {
  const context = useContext(AIAssistContext)
  if (!context) {
    throw new Error('useAIAssist must be used within an AIAssistProvider')
  }
  return context
}

/**
 * Provider props
 */
interface AIAssistProviderProps {
  children: ReactNode
  /** Knowledge base ID for search operations */
  knowledgeBaseId?: number
  /** Callback when content should be sent to chat */
  onSendToChat?: (content: string) => void
}

/**
 * AI Assist Provider Component
 */
export function AIAssistProvider({
  children,
  knowledgeBaseId: _knowledgeBaseId,
  onSendToChat,
}: AIAssistProviderProps) {
  const [state, dispatch] = useReducer(aiAssistReducer, initialState)
  const editorRef = useRef<_EditorRef | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Store callbacks in refs to avoid stale closures
  const _onSendToChatRef = useRef(onSendToChat)
  _onSendToChatRef.current = onSendToChat

  const _knowledgeBaseIdRef = useRef(_knowledgeBaseId)
  _knowledgeBaseIdRef.current = _knowledgeBaseId

  const setSelection = useCallback((selection: EditorSelection | null) => {
    dispatch({ type: 'SET_SELECTION', selection })
  }, [])

  const setCustomPrompt = useCallback((prompt: string) => {
    dispatch({ type: 'SET_CUSTOM_PROMPT', prompt })
  }, [])

  const setStatus = useCallback((status: AIAssistStatus) => {
    dispatch({ type: 'SET_STATUS', status })
  }, [])

  const appendContent = useCallback((content: string) => {
    dispatch({ type: 'APPEND_CONTENT', content })
  }, [])

  const completeOperation = useCallback((diff: DiffResult) => {
    dispatch({ type: 'COMPLETE_OPERATION', diff })
  }, [])

  const setError = useCallback((error: string | null) => {
    dispatch({ type: 'SET_ERROR', error })
  }, [])

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' })
  }, [])

  const cancelOperation = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    dispatch({ type: 'CANCEL_OPERATION' })
  }, [])

  const acceptDiff = useCallback(() => {
    const { activeDiff } = state
    if (!activeDiff || !editorRef.current) return

    // Apply the replacement to the editor
    editorRef.current.replaceSelection(activeDiff.from, activeDiff.to, activeDiff.replacement)
    dispatch({ type: 'ACCEPT_DIFF' })
  }, [state])

  const rejectDiff = useCallback(() => {
    dispatch({ type: 'REJECT_DIFF' })
  }, [])

  const startOperation = useCallback((action: AIAssistAction, customPrompt?: string) => {
    dispatch({ type: 'START_OPERATION', action })
    if (customPrompt) {
      dispatch({ type: 'SET_CUSTOM_PROMPT', prompt: customPrompt })
    }
    // The actual API call will be handled by the component using this context
    // This allows for better control over the streaming response
  }, [])

  const regenerate = useCallback(() => {
    const { lastAction, customPrompt } = state
    if (lastAction) {
      startOperation(lastAction, customPrompt || undefined)
    }
  }, [state, startOperation])

  const value: AIAssistContextValue = {
    state,
    editorRef,
    setSelection,
    startOperation,
    cancelOperation,
    acceptDiff,
    rejectDiff,
    regenerate,
    setCustomPrompt,
    setStatus,
    appendContent,
    completeOperation,
    setError,
    reset,
  }

  return <AIAssistContext.Provider value={value}>{children}</AIAssistContext.Provider>
}

export default AIAssistContext
