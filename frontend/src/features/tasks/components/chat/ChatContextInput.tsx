// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState } from 'react'
import AddContextButton from './AddContextButton'
import ContextSelector from './ContextSelector'
import type { ContextItem } from '@/types/context'
import { isChatContextEnabled } from '@/lib/runtime-config'

interface ChatContextInputProps {
  selectedContexts: ContextItem[]
  onContextsChange: (contexts: ContextItem[]) => void
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
}: ChatContextInputProps) {
  const [selectorOpen, setSelectorOpen] = useState(false)

  const handleSelect = (context: ContextItem) => {
    onContextsChange([...selectedContexts, context])
  }

  const handleDeselect = (id: number | string) => {
    onContextsChange(selectedContexts.filter(ctx => ctx.id !== id))
  }

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
    >
      <div>
        <AddContextButton onClick={() => setSelectorOpen(true)} />
      </div>
    </ContextSelector>
  )
}
