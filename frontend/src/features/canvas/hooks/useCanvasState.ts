// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Canvas state management hook
 */

import { useState, useEffect, useCallback } from 'react'
import { canvasApis } from '@/apis/canvas'

interface UseCanvasStateProps {
  taskId: number | undefined
}

export function useCanvasState({ taskId }: UseCanvasStateProps) {
  const [canvasEnabled, setCanvasEnabled] = useState(false)
  const [canvasContent, setCanvasContent] = useState('')
  const [canvasFileType, setCanvasFileType] = useState('text')
  const [canvasTitle, setCanvasTitle] = useState('Untitled')
  const [isLoading, setIsLoading] = useState(false)

  // Load canvas state when task changes
  useEffect(() => {
    if (!taskId) {
      setCanvasEnabled(false)
      setCanvasContent('')
      return
    }

    const loadCanvas = async () => {
      setIsLoading(true)
      try {
        const response = await canvasApis.getCanvas(taskId)
        setCanvasEnabled(response.enabled)
        setCanvasContent(response.content)
        setCanvasFileType(response.file_type)
        setCanvasTitle(response.title)
      } catch (error) {
        console.error('Failed to load canvas:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadCanvas()
  }, [taskId])

  const enableCanvas = useCallback(
    async (
      initialContent: string = '',
      fileType: string = 'text',
      title: string = 'Untitled'
    ) => {
      if (!taskId) return

      try {
        const response = await canvasApis.enableCanvas({
          task_id: taskId,
          initial_content: initialContent,
          file_type: fileType,
          title,
        })
        setCanvasEnabled(true)
        setCanvasContent(response.content)
        setCanvasFileType(response.file_type)
        setCanvasTitle(response.title)
      } catch (error) {
        console.error('Failed to enable canvas:', error)
      }
    },
    [taskId]
  )

  const disableCanvas = useCallback(async () => {
    if (!taskId) return

    try {
      await canvasApis.disableCanvas(taskId)
      setCanvasEnabled(false)
    } catch (error) {
      console.error('Failed to disable canvas:', error)
    }
  }, [taskId])

  const updateCanvas = useCallback(
    async (content: string, fileType?: string, title?: string) => {
      if (!taskId) return

      // Optimistic update
      setCanvasContent(content)
      if (fileType) setCanvasFileType(fileType)
      if (title) setCanvasTitle(title)

      try {
        await canvasApis.updateCanvas({
          task_id: taskId,
          content,
          file_type: fileType,
          title,
        })
      } catch (error) {
        console.error('Failed to update canvas:', error)
      }
    },
    [taskId]
  )

  return {
    canvasEnabled,
    canvasContent,
    canvasFileType,
    canvasTitle,
    isLoading,
    enableCanvas,
    disableCanvas,
    updateCanvas,
    setCanvasContent, // For real-time updates from WebSocket
  }
}
