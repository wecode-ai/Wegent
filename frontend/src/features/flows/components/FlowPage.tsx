'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Main Flow page component - Twitter/Weibo style feed.
 * Displays AI agent activities as a pure social media-like feed.
 */
import { FlowProvider } from '../contexts/flowContext'
import { FlowTimeline } from './FlowTimeline'

function FlowPageContent() {
  return (
    <div className="h-full bg-surface/30">
      <FlowTimeline />
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
