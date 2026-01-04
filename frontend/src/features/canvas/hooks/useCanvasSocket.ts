// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Canvas WebSocket hook for real-time synchronization
 */

import { useEffect, useState, useCallback } from 'react'
import { useSocket } from '@/hooks/useSocket'

interface UseCanvasSocketProps {
  taskId: number
  onContentUpdate: (content: string) => void
  onSelectionEdit?: (
    start: number,
    end: number,
    modifiedContent: string,
    explanation?: string
  ) => void
}

interface SelectionEditRequest {
  selectionStart: number
  selectionEnd: number
  selectedText: string
  instruction: string
}

export function useCanvasSocket({
  taskId,
  onContentUpdate,
  onSelectionEdit,
}: UseCanvasSocketProps) {
  const { socket } = useSocket()
  const [isProcessing, setIsProcessing] = useState(false)

  useEffect(() => {
    if (!socket) return

    // Listen for canvas updates from AI or other users
    const handleCanvasUpdate = (data: {
      task_id: number
      content: string
      file_type?: string
      title?: string
    }) => {
      if (data.task_id === taskId) {
        onContentUpdate(data.content)
        setIsProcessing(false)
      }
    }

    // Listen for canvas enable events
    const handleCanvasEnable = (data: {
      task_id: number
      content: string
      file_type: string
      title: string
    }) => {
      if (data.task_id === taskId) {
        onContentUpdate(data.content)
      }
    }

    // Listen for selection edit results
    const handleSelectionEdit = (data: {
      task_id: number
      selection_start: number
      selection_end: number
      modified_content: string
      explanation?: string
    }) => {
      if (data.task_id === taskId) {
        if (onSelectionEdit) {
          onSelectionEdit(
            data.selection_start,
            data.selection_end,
            data.modified_content,
            data.explanation
          )
        }
        setIsProcessing(false)
      }
    }

    // Listen for canvas sync events
    const handleCanvasSync = (data: {
      task_id: number
      content: string
      file_type: string
      title: string
    }) => {
      if (data.task_id === taskId) {
        onContentUpdate(data.content)
      }
    }

    socket.on('canvas:update', handleCanvasUpdate)
    socket.on('canvas:enable', handleCanvasEnable)
    socket.on('canvas:selection:edit', handleSelectionEdit)
    socket.on('canvas:sync', handleCanvasSync)

    return () => {
      socket.off('canvas:update', handleCanvasUpdate)
      socket.off('canvas:enable', handleCanvasEnable)
      socket.off('canvas:selection:edit', handleSelectionEdit)
      socket.off('canvas:sync', handleCanvasSync)
    }
  }, [socket, taskId, onContentUpdate, onSelectionEdit])

  const sendSelectionEdit = useCallback(
    async (request: SelectionEditRequest) => {
      if (!socket) return

      setIsProcessing(true)

      // Emit selection edit request to server
      socket.emit('canvas:selection:edit:request', {
        task_id: taskId,
        ...request,
      })
    },
    [socket, taskId]
  )

  return {
    isProcessing,
    sendSelectionEdit,
  }
}
