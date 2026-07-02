// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback, type Dispatch, type SetStateAction } from 'react'
import AddContextButton from './AddContextButton'
import ContextSelector from './ContextSelector'
import type { ContextItem } from '@/types/context'
import { isChatContextEnabled } from '@/lib/runtime-config'

interface ChatContextInputProps {
  selectedContexts: ContextItem[]
  onContextsChange: Dispatch<SetStateAction<ContextItem[]>>
  /** Knowledge base ID to exclude from the list (used in notebook mode to hide current KB) */
  excludeKnowledgeBaseId?: number
  /** Render style for the selector trigger */
  triggerVariant?: 'button' | 'menu-item'
  /** Render compact icon-only desktop trigger */
  iconOnly?: boolean
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
  triggerVariant = 'button',
  iconOnly = false,
}: ChatContextInputProps) {
  const [selectorOpen, setSelectorOpen] = useState(false)

  const handleSelect = useCallback(
    (context: ContextItem) => {
      onContextsChange(prev => {
        if (prev.some(ctx => ctx.id === context.id)) return prev
        return [...prev, context]
      })
    },
    [onContextsChange]
  )

  const handleDeselect = useCallback(
    (id: number | string) => {
      onContextsChange(prev => prev.filter(ctx => ctx.id !== id))
    },
    [onContextsChange]
  )

  // Handle batch selection for group knowledge bases
  // This is critical to avoid the closure problem when selecting multiple items
  const handleSelectMultiple = useCallback(
    (contextsToAdd: ContextItem[]) => {
      onContextsChange(prev => {
        const existingIds = new Set(prev.map(ctx => ctx.id))
        const nextContexts = contextsToAdd.filter(ctx => !existingIds.has(ctx.id))
        if (nextContexts.length === 0) return prev
        return [...prev, ...nextContexts]
      })
    },
    [onContextsChange]
  )

  // Handle batch deselection for group knowledge bases
  const handleDeselectMultiple = useCallback(
    (ids: (number | string)[]) => {
      const idSet = new Set(ids)
      onContextsChange(prev => prev.filter(ctx => !idSet.has(ctx.id)))
    },
    [onContextsChange]
  )

  const handleReplaceContexts = useCallback(
    (idsToRemove: (number | string)[], contextsToAdd: ContextItem[]) => {
      const idSet = new Set(idsToRemove)
      onContextsChange(prev => {
        const remainingContexts = prev.filter(ctx => !idSet.has(ctx.id))
        const existingIds = new Set(remainingContexts.map(ctx => ctx.id))
        const nextContexts = contextsToAdd.filter(ctx => !existingIds.has(ctx.id))
        return [...remainingContexts, ...nextContexts]
      })
    },
    [onContextsChange]
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
      onReplaceContexts={handleReplaceContexts}
      excludeKnowledgeBaseId={excludeKnowledgeBaseId}
    >
      <div>
        <AddContextButton
          onClick={() => setSelectorOpen(true)}
          selectedCount={selectedContexts.length}
          triggerVariant={triggerVariant}
          iconOnly={iconOnly}
        />
      </div>
    </ContextSelector>
  )
}
