// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react'
import browser from 'webextension-polyfill'
import {
  createResponse,
  extractTaskIdFromResponseId,
  getFrontendUrl,
  getUnifiedModels,
} from '@shared/api'
import type { ExtractedContent } from '@shared/extractor'
import type { UnifiedModel } from '@shared/api/types'

interface ChatSectionProps {
  content: ExtractedContent | null
  defaultExpanded?: boolean
}

function ChatSection({ content, defaultExpanded = false }: ChatSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const [question, setQuestion] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('default#wegent-chat')
  const [isLoadingModels, setIsLoadingModels] = useState(false)

  // Load models when section expands
  useEffect(() => {
    if (isExpanded && models.length === 0) {
      loadModels()
    }
  }, [isExpanded])

  const loadModels = async () => {
    setIsLoadingModels(true)
    try {
      // Filter models compatible with Chat shell type
      const modelList = await getUnifiedModels('Chat')
      setModels(modelList)
    } catch (err) {
      console.error('Failed to load models:', err)
      // Keep default model if loading fails
    } finally {
      setIsLoadingModels(false)
    }
  }

  const handleSend = async () => {
    if (!content || !question.trim()) return

    setIsLoading(true)
    setError(null)

    try {
      // Build input text with question and webpage content
      const title = content.metadata.title || 'Webpage Content'
      const inputText = `${question}

---
**Reference Content: ${title}**
${content.metadata.url ? `Source: ${content.metadata.url}` : ''}

${content.markdown}
`

      // Create response using /v1/responses API with stream: true
      // This returns immediately with task ID, allowing us to redirect quickly
      // The model format is "namespace#team_name" or "namespace#team_name#model_id"
      const response = await createResponse({
        model: selectedModel,
        input: inputText,
        stream: true,
      })

      // Extract task ID from response ID (format: "resp_{task_id}")
      const taskId = extractTaskIdFromResponseId(response.id)

      // Open the chat page
      const frontendUrl = await getFrontendUrl()
      await browser.runtime.sendMessage({
        type: 'OPEN_CHAT_PAGE',
        data: { taskId, frontendUrl },
      })

      // Clear the form
      setQuestion('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="border-b border-border">
      {/* Section Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between px-4 py-3 hover:bg-surface"
      >
        <div className="flex items-center gap-2">
          <svg
            className="h-4 w-4 text-primary"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
          <span className="text-sm font-medium text-text-primary">Send to Chat</span>
        </div>
        <svg
          className={`h-4 w-4 text-text-secondary transition-transform ${
            isExpanded ? 'rotate-180' : ''
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {/* Section Content */}
      {isExpanded && (
        <div className="animate-fadeIn px-4 pb-4">
          {/* Model Selector */}
          <div className="mb-3">
            <label className="mb-1 block text-xs text-text-secondary">Model</label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={isLoading || isLoadingModels}
              className="w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="default#wegent-chat">Default (wegent-chat)</option>
              {models.map((model) => {
                const modelValue =
                  model.type === 'public'
                    ? `default#wegent-chat#${model.name}`
                    : `${model.namespace}#wegent-chat#${model.name}`
                const displayName = model.displayName || model.name
                const typeLabel = model.type === 'public' ? '' : ` (${model.type})`
                return (
                  <option key={`${model.type}-${model.name}`} value={modelValue}>
                    {displayName}
                    {typeLabel}
                  </option>
                )
              })}
            </select>
          </div>

          {/* Question Input */}
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Enter your question about this content..."
            className="w-full resize-none rounded-lg border border-border bg-base px-3 py-2 text-sm text-text-primary placeholder:text-text-muted"
            rows={3}
            disabled={!content || isLoading}
          />

          {/* Error message */}
          {error && (
            <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
              {error}
            </div>
          )}

          {/* Send Button */}
          <button
            onClick={handleSend}
            disabled={!content || !question.trim() || isLoading}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                <span>Sending...</span>
              </>
            ) : (
              <>
                <span>Send and Open Chat</span>
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M14 5l7 7m0 0l-7 7m7-7H3"
                  />
                </svg>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}

export default ChatSection
