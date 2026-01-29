// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react'
import {
  listKnowledgeBases,
  uploadTextContent,
  addDocumentToKnowledgeBase,
} from '@shared/api'
import { getStorageValue, setStorageValue } from '@shared/storage'
import type { ExtractedContent } from '@shared/extractor'
import type { KnowledgeBase } from '@shared/api/types'

interface KnowledgeSectionProps {
  content: ExtractedContent | null
  defaultExpanded?: boolean
}

function KnowledgeSection({ content, defaultExpanded = false }: KnowledgeSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [selectedKbId, setSelectedKbId] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingKbs, setIsLoadingKbs] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // Load knowledge bases when section expands
  useEffect(() => {
    if (isExpanded && knowledgeBases.length === 0) {
      loadKnowledgeBases()
    }
  }, [isExpanded])

  // Load default selection
  useEffect(() => {
    loadDefaultKbId()
  }, [])

  const loadDefaultKbId = async () => {
    const defaultId = await getStorageValue('defaultKnowledgeBaseId')
    if (defaultId) {
      setSelectedKbId(defaultId)
    }
  }

  const loadKnowledgeBases = async () => {
    setIsLoadingKbs(true)
    try {
      const kbs = await listKnowledgeBases('all')
      setKnowledgeBases(kbs)

      // If no selection and there are KBs, select the first one
      if (!selectedKbId && kbs.length > 0) {
        setSelectedKbId(kbs[0].id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load knowledge bases')
    } finally {
      setIsLoadingKbs(false)
    }
  }

  const handleAdd = async () => {
    if (!content || !selectedKbId) return

    setIsLoading(true)
    setError(null)
    setSuccess(false)

    try {
      // 1. Upload content as attachment
      const filename = `${content.metadata.title || 'webpage'}_${Date.now()}.md`
      const attachment = await uploadTextContent(content.markdown, filename)

      // 2. Add to knowledge base
      await addDocumentToKnowledgeBase(selectedKbId, {
        attachment_id: attachment.id,
        source_type: 'TEXT',
        name: content.metadata.title || 'Web Content',
        metadata: {
          source_url: content.metadata.url,
          extracted_at: content.extractedAt,
        },
      })

      setSuccess(true)

      // Save as default KB
      await setStorageValue('defaultKnowledgeBaseId', selectedKbId)

      // Clear success after 3 seconds
      setTimeout(() => setSuccess(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add to knowledge base')
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
              d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
            />
          </svg>
          <span className="text-sm font-medium text-text-primary">Add to Knowledge Base</span>
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
          {/* Knowledge Base Selector */}
          <div className="mb-3">
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Select Knowledge Base
            </label>
            {isLoadingKbs ? (
              <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                <span className="text-sm text-text-secondary">Loading...</span>
              </div>
            ) : (
              <select
                value={selectedKbId || ''}
                onChange={(e) => setSelectedKbId(Number(e.target.value))}
                className="w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text-primary"
                disabled={!content || isLoading}
              >
                {knowledgeBases.length === 0 ? (
                  <option value="">No knowledge bases available</option>
                ) : (
                  knowledgeBases.map((kb) => (
                    <option key={kb.id} value={kb.id}>
                      {kb.name} ({kb.document_count} docs)
                    </option>
                  ))
                )}
              </select>
            )}
          </div>

          {/* Error message */}
          {error && (
            <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
              {error}
            </div>
          )}

          {/* Success message */}
          {success && (
            <div className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-xs text-green-600">
              Successfully added to knowledge base!
            </div>
          )}

          {/* Add Button */}
          <button
            onClick={handleAdd}
            disabled={!content || !selectedKbId || isLoading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                <span>Adding...</span>
              </>
            ) : (
              <>
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
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                <span>Add to Knowledge Base</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}

export default KnowledgeSection
