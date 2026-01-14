// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Main Canvas container component.
 * Manages the canvas panel with editor, diff view, and version history.
 */

'use client'

import React, { useState, useCallback, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { CanvasEditor } from './CanvasEditor'
import { CanvasDiffView } from './CanvasDiffView'
import { CanvasToolbar } from './CanvasToolbar'
import { CanvasVersionHistory } from './CanvasVersionHistory'
import { useCanvasState } from './useCanvasState'
import { useSocket } from '@/contexts/SocketContext'
import { CanvasServerEvents } from '@/types/canvas'
import type { CanvasUpdatePayload, CanvasRollbackPayload } from '@/types/canvas'

interface CanvasProps {
  subtaskId: number
  canvasId?: number
  onClose?: () => void
  className?: string
}

export function Canvas({ subtaskId, canvasId, onClose, className }: CanvasProps) {
  const [showHistory, setShowHistory] = useState(false)
  const {
    state,
    loadCanvas,
    updateContent,
    handleAIUpdate,
    handleRollback,
    rollbackToVersion,
    loadVersions,
    exportFile,
    acceptDiff,
    rejectDiff,
    closeCanvas,
  } = useCanvasState()

  const { socket } = useSocket()

  // Load canvas on mount if canvasId is provided
  useEffect(() => {
    if (canvasId) {
      loadCanvas(canvasId)
    }
  }, [canvasId, loadCanvas])

  // Register WebSocket event handlers
  useEffect(() => {
    if (!socket) return

    const handleCanvasUpdate = (payload: CanvasUpdatePayload) => {
      if (payload.canvas_id === state.canvasId) {
        handleAIUpdate(payload)
      }
    }

    const handleCanvasRollback = (payload: CanvasRollbackPayload) => {
      if (payload.canvas_id === state.canvasId) {
        handleRollback(payload)
      }
    }

    socket.on(CanvasServerEvents.CANVAS_UPDATE, handleCanvasUpdate)
    socket.on(CanvasServerEvents.CANVAS_ROLLBACK, handleCanvasRollback)

    return () => {
      socket.off(CanvasServerEvents.CANVAS_UPDATE, handleCanvasUpdate)
      socket.off(CanvasServerEvents.CANVAS_ROLLBACK, handleCanvasRollback)
    }
  }, [socket, state.canvasId, handleAIUpdate, handleRollback])

  // Debounced content update
  const handleContentChange = useCallback(
    (content: string) => {
      // Update local state immediately for responsive editing
      // The actual save will be triggered on blur or after a delay
      // For now, we just update the content
      updateContent(content)
    },
    [updateContent]
  )

  const handleShowHistory = useCallback(() => {
    loadVersions()
    setShowHistory(true)
  }, [loadVersions])

  const handleCloseHistory = useCallback(() => {
    setShowHistory(false)
  }, [])

  const handleClose = useCallback(() => {
    closeCanvas()
    onClose?.()
  }, [closeCanvas, onClose])

  const handleRollbackToVersion = useCallback(
    async (version: number) => {
      await rollbackToVersion(version)
      // Reload versions to show the new rollback entry
      loadVersions()
    },
    [rollbackToVersion, loadVersions]
  )

  if (!state.canvasId && !canvasId) {
    return null
  }

  return (
    <div className={cn('flex h-full bg-base', className)}>
      {/* Main canvas area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <CanvasToolbar
          filename={state.filename}
          version={state.version}
          onExport={exportFile}
          onShowHistory={handleShowHistory}
          onClose={handleClose}
        />

        {/* Editor or Diff view */}
        <div className="flex-1 overflow-hidden p-4">
          {state.isDiffMode && state.diffInfo ? (
            <CanvasDiffView
              diffInfo={state.diffInfo}
              onAccept={acceptDiff}
              onReject={rejectDiff}
            />
          ) : (
            <CanvasEditor
              content={state.content}
              onChange={handleContentChange}
              readOnly={state.isLoading}
            />
          )}
        </div>

        {/* Error display */}
        {state.error && (
          <div className="px-4 pb-4">
            <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-600 dark:text-red-400">
              {state.error}
            </div>
          </div>
        )}

        {/* Loading indicator */}
        {state.isLoading && (
          <div className="absolute inset-0 bg-base/50 flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Version history panel */}
      {showHistory && (
        <CanvasVersionHistory
          versions={state.versions}
          currentVersion={state.version}
          onRollback={handleRollbackToVersion}
          onClose={handleCloseHistory}
        />
      )}
    </div>
  )
}
