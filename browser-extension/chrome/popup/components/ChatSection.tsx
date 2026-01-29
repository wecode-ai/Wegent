// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react'
import browser from 'webextension-polyfill'
import { uploadTextContent, createTaskId, createTask, sendChatMessage, getServerUrl } from '@shared/api'
import type { ExtractedContent } from '@shared/extractor'

interface ChatSectionProps {
  content: ExtractedContent | null
  defaultExpanded?: boolean
}

function ChatSection({ content, defaultExpanded = false }: ChatSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const [question, setQuestion] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSend = async () => {
    if (!content || !question.trim()) return

    setIsLoading(true)
    setError(null)

    try {
      // 1. Upload content as attachment
      const filename = `${content.metadata.title || 'webpage'}_${Date.now()}.md`
      const attachment = await uploadTextContent(content.markdown, filename)

      // 2. Create a new task
      const { task_id: taskId } = await createTaskId()

      // 3. Create the task with default team (no team_id specified)
      await createTask(taskId, {
        prompt: question,
        title: content.metadata.title || 'Web Content Chat',
      })

      // 4. Send the message via WebSocket
      await sendChatMessage({
        message: question,
        task_id: taskId,
        attachment_id: attachment.id,
      })

      // 5. Open the chat page
      const serverUrl = await getServerUrl()
      await browser.runtime.sendMessage({
        type: 'OPEN_CHAT_PAGE',
        data: { taskId, serverUrl },
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
