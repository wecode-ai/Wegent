// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '@/apis/client'
import { createTextKnowledgeDocument } from '@/apis/knowledge'
import type { KnowledgeDocument } from '@/types/knowledge'

export const MAX_KNOWLEDGE_DOCUMENT_TITLE_LENGTH = 255
export const MAX_KNOWLEDGE_DOCUMENT_CONTENT_LENGTH = 500_000

export type SaveKnowledgeDocumentError =
  | 'permissionChanged'
  | 'targetMissing'
  | 'invalidContent'
  | 'saveFailed'

interface UseSaveKnowledgeDocumentOptions {
  open: boolean
  initialTitle: string
  initialContent: string
  presentContent?: (content: string) => string
  knowledgeBaseId?: number
  onSaved: (document: KnowledgeDocument) => void
  onError?: (error: SaveKnowledgeDocumentError) => void
  onTargetUnavailable?: () => void
}

function classifySaveError(error: unknown): SaveKnowledgeDocumentError {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'permissionChanged'
    if (error.status === 404) return 'targetMissing'
    if (error.status === 422) return 'invalidContent'
  }
  return 'saveFailed'
}

export function useSaveKnowledgeDocument({
  open,
  initialTitle,
  initialContent,
  presentContent,
  knowledgeBaseId,
  onSaved,
  onError,
  onTargetUnavailable,
}: UseSaveKnowledgeDocumentOptions) {
  const [title, setTitle] = useState(initialTitle)
  const [draft, setDraft] = useState({ content: initialContent, revision: 0 })
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<SaveKnowledgeDocumentError>()

  useEffect(() => {
    if (!open) return
    setTitle(initialTitle)
    setDraft(previous => ({ ...previous, content: initialContent }))
    setError(undefined)
  }, [initialContent, initialTitle, open])

  const setContent = useCallback((content: string) => {
    setDraft(previous => (previous.content === content ? previous : { ...previous, content }))
  }, [])
  const content = open ? (presentContent?.(draft.content) ?? draft.content) : draft.content
  // Persist the filtered draft so lost markers cannot return when access recovers.
  if (content !== draft.content) {
    setDraft({ content, revision: draft.revision + 1 })
  }

  const trimmedTitle = title.trim()
  const trimmedContent = content.trim()
  const isValid =
    knowledgeBaseId !== undefined &&
    trimmedTitle.length > 0 &&
    trimmedTitle.length <= MAX_KNOWLEDGE_DOCUMENT_TITLE_LENGTH &&
    trimmedContent.length > 0 &&
    content.length <= MAX_KNOWLEDGE_DOCUMENT_CONTENT_LENGTH

  const submit = async () => {
    if (!isValid || knowledgeBaseId === undefined) return
    setIsSaving(true)
    setError(undefined)
    try {
      const document = await createTextKnowledgeDocument({
        knowledge_base_id: knowledgeBaseId,
        name: trimmedTitle,
        content: trimmedContent,
      })
      onSaved(document)
    } catch (nextError) {
      const classifiedError = classifySaveError(nextError)
      setError(classifiedError)
      if (classifiedError === 'permissionChanged' || classifiedError === 'targetMissing') {
        onTargetUnavailable?.()
      }
      onError?.(classifiedError)
    } finally {
      setIsSaving(false)
    }
  }

  return {
    title,
    setTitle,
    content,
    contentRevision: draft.revision,
    setContent,
    isSaving,
    isValid,
    error,
    clearError: () => setError(undefined),
    submit,
  }
}
