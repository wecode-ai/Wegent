'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Main Flow page component - Twitter/Weibo style feed.
 * Displays AI agent activities as a pure social media-like feed.
 */
import { useState, useCallback } from 'react'
import { FlowProvider, useFlowContext } from '../contexts/flowContext'
import { FlowTimeline } from './FlowTimeline'
import { FlowForm } from './FlowForm'

function FlowPageContent() {
  const [isFormOpen, setIsFormOpen] = useState(false)
  const { refreshFlows, refreshExecutions } = useFlowContext()

  const handleCreateFlow = useCallback(() => {
    setIsFormOpen(true)
  }, [])

  const handleFormSuccess = useCallback(() => {
    refreshFlows()
    refreshExecutions()
  }, [refreshFlows, refreshExecutions])

  return (
    <div className="h-full bg-surface/30">
      <FlowTimeline onCreateFlow={handleCreateFlow} />
      <FlowForm open={isFormOpen} onOpenChange={setIsFormOpen} onSuccess={handleFormSuccess} />
    </div>
  )
}

export function FlowPage() {
  return (
    <FlowProvider>
      <FlowPageContent />
    </FlowProvider>
  )
}
