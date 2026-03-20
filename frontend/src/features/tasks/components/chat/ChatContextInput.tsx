// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback } from 'react'
import AddContextButton from './AddContextButton'
import ContextSelector from './ContextSelector'
import type { ContextItem } from '@/types/context'
import { isChatContextEnabled } from '@/lib/runtime-config'

interface ChatContextInputProps {
  selectedContexts: ContextItem[]
  onContextsChange: (contexts: ContextItem[]) => void
  /** Knowledge base ID to exclude from the list (used in notebook mode to hide current KB) */
  excludeKnowledgeBaseId?: number
}

/**
 * Generic context input component for chat
 * Currently supports: knowledge_base, table
 * Future: person, bot, team
 *
 * Note: Badge rendering is now handled by InputBadgeDisplay component
 * This component only handles the button and selector logic
 */
export default function ChatContextInput({
  selectedContexts,
  onContextsChange,
  excludeKnowledgeBaseId,
}: ChatContextInputProps) {
  const [selectorOpen, setSelectorOpen] = useState(false)

  const handleSelect = useCallback(
    (context: ContextItem) => {
      onContextsChange([...selectedContexts, context])
    },
    [selectedContexts, onContextsChange]
  )

  const handleDeselect = useCallback(
    (id: number | string) => {
      onContextsChange(selectedContexts.filter(ctx => ctx.id !== id))
    },
    [selectedContexts, onContextsChange]
  )

  // Handle batch selection for group knowledge bases
  // This is critical to avoid the closure problem when selecting multiple items
  const handleSelectMultiple = useCallback(
    (contextsToAdd: ContextItem[]) => {
      onContextsChange([...selectedContexts, ...contextsToAdd])
    },
    [selectedContexts, onContextsChange]
  )

  // Handle batch deselection for group knowledge bases
  const handleDeselectMultiple = useCallback(
    (ids: (number | string)[]) => {
      const idSet = new Set(ids)
      onContextsChange(selectedContexts.filter(ctx => !idSet.has(ctx.id)))
    },
    [selectedContexts, onContextsChange]
  )

  // If chat context feature is disabled, don't render anything
  if (!isChatContextEnabled()) {
    return null
  }

  return (
    <ContextSelector
      open={selectorOpen}
      onOpenChange={setSelectorOpen}
      selectedContexts={selectedContexts}
      onSelect={handleSelect}
      onDeselect={handleDeselect}
      onSelectMultiple={handleSelectMultiple}
      onDeselectMultiple={handleDeselectMultiple}
      excludeKnowledgeBaseId={excludeKnowledgeBaseId}
    >
      <div>
        <AddContextButton onClick={() => setSelectorOpen(true)} />
      </div>
    </ContextSelector>
  )
}
