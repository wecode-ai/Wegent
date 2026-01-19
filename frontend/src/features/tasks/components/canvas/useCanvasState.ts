// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for managing canvas document state.
 */

import { useState, useCallback, useEffect } from 'react'
import {
  createCanvas,
  getCanvas,
  updateCanvas,
  getCanvasVersions,
  rollbackCanvas,
  getCanvasExportUrl,
} from '@/apis/canvas'
import type {
  Canvas,
  CanvasState,
  CanvasDiffInfo,
  CanvasVersionInfo,
  CanvasUpdatePayload,
  CanvasRollbackPayload,
} from '@/types/canvas'

interface UseCanvasStateReturn {
  state: CanvasState
  createNewCanvas: (subtaskId: number, filename?: string, content?: string) => Promise<Canvas | null>
  loadCanvas: (canvasId: number) => Promise<void>
  updateContent: (content: string) => Promise<void>
  handleAIUpdate: (payload: CanvasUpdatePayload) => void
  handleRollback: (payload: CanvasRollbackPayload) => void
  rollbackToVersion: (version: number) => Promise<void>
  loadVersions: () => Promise<void>
  exportFile: (format: 'md' | 'txt') => void
  acceptDiff: () => void
  rejectDiff: () => void
  closeCanvas: () => void
  isOpen: boolean
}

const initialState: CanvasState = {
  canvasId: null,
  filename: 'untitled.txt',
  content: '',
  version: 0,
  versions: [],
  isLoading: false,
  isDiffMode: false,
  diffInfo: null,
  error: null,
}

export function useCanvasState(): UseCanvasStateReturn {
  const [state, setState] = useState<CanvasState>(initialState)

  const createNewCanvas = useCallback(
    async (subtaskId: number, filename?: string, content?: string): Promise<Canvas | null> => {
      setState(prev => ({ ...prev, isLoading: true, error: null }))

      try {
        const canvas = await createCanvas({
          subtask_id: subtaskId,
          filename: filename || 'untitled.txt',
          content: content || '',
        })

        setState({
          canvasId: canvas.id,
          filename: canvas.filename,
          content: canvas.content,
          version: canvas.version,
          versions: [],
          isLoading: false,
          isDiffMode: false,
          diffInfo: null,
          error: null,
        })

        return canvas
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to create canvas'
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: errorMessage,
        }))
        return null
      }
    },
    []
  )

  const loadCanvas = useCallback(async (canvasId: number) => {
    setState(prev => ({ ...prev, isLoading: true, error: null }))

    try {
      const canvas = await getCanvas(canvasId)
      setState({
        canvasId: canvas.id,
        filename: canvas.filename,
        content: canvas.content,
        version: canvas.version,
        versions: [],
        isLoading: false,
        isDiffMode: false,
        diffInfo: null,
        error: null,
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load canvas'
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: errorMessage,
      }))
    }
  }, [])

  const updateContent = useCallback(
    async (content: string) => {
      if (!state.canvasId) return

      setState(prev => ({ ...prev, isLoading: true, error: null }))

      try {
        const canvas = await updateCanvas(state.canvasId, { content })
        setState(prev => ({
          ...prev,
          content: canvas.content,
          version: canvas.version,
          isLoading: false,
        }))
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to update canvas'
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: errorMessage,
        }))
      }
    },
    [state.canvasId]
  )

  const handleAIUpdate = useCallback((payload: CanvasUpdatePayload) => {
    if (payload.canvas_id !== state.canvasId) return

    const diffInfo: CanvasDiffInfo = {
      oldStr: payload.diff_info.old_str,
      newStr: payload.diff_info.new_str,
      oldContent: state.content,
      newContent: payload.new_content,
    }

    setState(prev => ({
      ...prev,
      content: payload.new_content,
      version: payload.version,
      isDiffMode: true,
      diffInfo,
    }))
  }, [state.canvasId, state.content])

  const handleRollback = useCallback((payload: CanvasRollbackPayload) => {
    if (payload.canvas_id !== state.canvasId) return

    setState(prev => ({
      ...prev,
      content: payload.content,
      version: payload.version,
      isDiffMode: false,
      diffInfo: null,
    }))
  }, [state.canvasId])

  const rollbackToVersion = useCallback(
    async (version: number) => {
      if (!state.canvasId) return

      setState(prev => ({ ...prev, isLoading: true, error: null }))

      try {
        const canvas = await rollbackCanvas(state.canvasId, { version })
        setState(prev => ({
          ...prev,
          content: canvas.content,
          version: canvas.version,
          isLoading: false,
          isDiffMode: false,
          diffInfo: null,
        }))
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to rollback'
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: errorMessage,
        }))
      }
    },
    [state.canvasId]
  )

  const loadVersions = useCallback(async () => {
    if (!state.canvasId) return

    try {
      const response = await getCanvasVersions(state.canvasId)
      setState(prev => ({
        ...prev,
        versions: response.versions,
      }))
    } catch (err) {
      console.error('Failed to load versions:', err)
    }
  }, [state.canvasId])

  const exportFile = useCallback(
    (format: 'md' | 'txt') => {
      if (!state.canvasId) return
      const url = getCanvasExportUrl(state.canvasId, format)
      window.open(url, '_blank')
    },
    [state.canvasId]
  )

  const acceptDiff = useCallback(() => {
    setState(prev => ({
      ...prev,
      isDiffMode: false,
      diffInfo: null,
    }))
  }, [])

  const rejectDiff = useCallback(() => {
    if (!state.diffInfo) return

    setState(prev => ({
      ...prev,
      content: prev.diffInfo?.oldContent || prev.content,
      isDiffMode: false,
      diffInfo: null,
    }))
  }, [state.diffInfo])

  const closeCanvas = useCallback(() => {
    setState(initialState)
  }, [])

  return {
    state,
    createNewCanvas,
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
    isOpen: state.canvasId !== null,
  }
}
