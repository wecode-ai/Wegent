// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useRef } from 'react'
import { useAIAssist } from '../AIAssistContext'
import type { AIAssistAction, AIAssistRequest, DiffResult, AIAssistSource } from '../types'

/**
 * System prompts for different AI actions
 */
const ACTION_PROMPTS: Record<AIAssistAction, string> = {
  rewrite:
    'Please rewrite the following text to make it clearer, more concise, and professional. Maintain the original meaning and tone. Return only the rewritten text without any explanation.',
  expand:
    'Please expand the following text with more details, examples, or explanations. Keep the original content and add relevant information. Return only the expanded text without any explanation.',
  summarize:
    'Please summarize the following text into a concise version that captures the key points. Return only the summary without any explanation.',
  fix_grammar:
    'Please fix any grammar, spelling, and punctuation errors in the following text. Maintain the original meaning and style. Return only the corrected text without any explanation.',
  custom: '', // Will be filled with user's custom prompt
  continue:
    'Based on the context provided, please continue writing naturally. Match the style and tone of the existing content. Return only the continuation without any explanation.',
  outline:
    'Please generate an outline for a document based on the context provided. Use markdown format with headers and bullet points. Return only the outline without any explanation.',
  search:
    'Please search for relevant information and expand the content with properly cited sources. Include footnote references [^1], [^2], etc. for any facts or information you include. Return the expanded content with a "References" section at the end.',
}

/**
 * Build the system message for the AI request
 */
function buildSystemPrompt(action: AIAssistAction, customPrompt?: string): string {
  if (action === 'custom' && customPrompt) {
    return `Please process the following text according to this instruction: ${customPrompt}. Return only the result without any explanation.`
  }
  return ACTION_PROMPTS[action]
}

/**
 * Build the user message with content and context
 */
function buildUserMessage(content: string, context?: string): string {
  if (context) {
    return `Context:\n${context}\n\nContent to process:\n${content}`
  }
  return content
}

interface UseAIAssistAPIOptions {
  /** Knowledge base ID for search operations */
  knowledgeBaseId?: number
  /** API base URL */
  apiBaseUrl?: string
}

/**
 * Hook for handling AI Assist API calls
 */
export function useAIAssistAPI(options: UseAIAssistAPIOptions = {}) {
  const { knowledgeBaseId, apiBaseUrl = '/api/v1' } = options
  const {
    state,
    setStatus,
    appendContent,
    completeOperation,
    setError,
    editorRef,
  } = useAIAssist()

  const abortControllerRef = useRef<AbortController | null>(null)

  /**
   * Process AI assist request
   */
  const processRequest = useCallback(
    async (action: AIAssistAction, customPrompt?: string) => {
      // Get selection and context from editor
      const selection = state.selection
      if (!selection && action !== 'continue' && action !== 'outline') {
        setError('No text selected')
        return
      }

      const content = selection?.text || ''
      let context = ''

      // Get context for continue/outline actions
      if (action === 'continue' || action === 'outline' || action === 'search') {
        if (editorRef.current) {
          const ctx = editorRef.current.getContext(500, 500)
          context = `${ctx.before}\n[CURSOR POSITION]\n${ctx.after}`
        }
      }

      // Cancel any pending request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }

      abortControllerRef.current = new AbortController()
      const signal = abortControllerRef.current.signal

      try {
        setStatus(action === 'search' ? 'searching' : 'generating')

        const systemPrompt = buildSystemPrompt(action, customPrompt)
        const userMessage = buildUserMessage(content, context)

        // Make API request
        const response = await fetch(`${apiBaseUrl}/ai-assist/process`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action,
            content,
            context,
            custom_prompt: customPrompt,
            knowledge_base_id: knowledgeBaseId,
            enable_web_search: action === 'search',
            system_prompt: systemPrompt,
            user_message: userMessage,
          } as AIAssistRequest),
          signal,
        })

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`)
        }

        // Handle streaming response
        const reader = response.body?.getReader()
        if (!reader) {
          throw new Error('No response body')
        }

        const decoder = new TextDecoder()
        let accumulatedContent = ''
        let sources: AIAssistSource[] = []
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6))

                if (data.type === 'chunk') {
                  accumulatedContent += data.content || ''
                  appendContent(data.content || '')
                } else if (data.type === 'done') {
                  if (data.sources) {
                    // Map snake_case to camelCase
                    sources = data.sources.map(
                      (source: AIAssistSource & { kb_id?: number; document_id?: number }) => ({
                        ...source,
                        kbId: source.kb_id ?? source.kbId,
                        documentId: source.document_id ?? source.documentId,
                      })
                    )
                  }
                } else if (data.type === 'error') {
                  throw new Error(data.error || 'Unknown error')
                }
              } catch (_parseError) {
                // Skip non-JSON lines
              }
            }
          }
        }

        // Process any remaining buffer content
        if (buffer.startsWith('data: ')) {
          try {
            const data = JSON.parse(buffer.slice(6))
            if (data.type === 'chunk') {
              accumulatedContent += data.content || ''
              appendContent(data.content || '')
            } else if (data.type === 'done' && data.sources) {
              sources = data.sources.map(
                (source: AIAssistSource & { kb_id?: number; document_id?: number }) => ({
                  ...source,
                  kbId: source.kb_id ?? source.kbId,
                  documentId: source.document_id ?? source.documentId,
                })
              )
            } else if (data.type === 'error') {
              throw new Error(data.error || 'Unknown error')
            }
          } catch (_parseError) {
            // Ignore trailing partial
          }
        }

        // Complete the operation
        const diff: DiffResult = {
          original: content,
          replacement: accumulatedContent,
          from: selection?.from || 0,
          to: selection?.to || 0,
          sources: sources.length > 0 ? sources : undefined,
        }

        completeOperation(diff)
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          // Request was cancelled
          return
        }

        console.error('AI Assist error:', error)
        setError((error as Error).message || 'Processing failed')
      }
    },
    [
      state.selection,
      editorRef,
      setStatus,
      appendContent,
      completeOperation,
      setError,
      knowledgeBaseId,
      apiBaseUrl,
    ]
  )

  /**
   * Cancel the current request
   */
  const cancelRequest = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  return {
    processRequest,
    cancelRequest,
  }
}

export default useAIAssistAPI
