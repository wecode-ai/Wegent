// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for recovering and resuming streaming content when user refreshes during streaming.
 *
 * This hook uses the unified stream endpoint with offset-based continuation:
 * 1. Fetches cached content from Redis/DB
 * 2. Automatically resumes streaming via the unified stream endpoint
 * 3. Uses offset to avoid duplicate data
 * 4. Continues accumulating content as it arrives
 * 5. Handles stream completion and errors
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { chatApis, type ChatStreamData } from '@/apis/chat'

export interface RecoveryState {
  /** Whether recovery was successful */
  recovered: boolean
  /** Recovered content */
  content: string
  /** Source of the content */
  source: 'redis' | 'database' | null
  /** Whether still streaming */
  streaming: boolean
  /** Whether content is incomplete (client disconnected) */
  incomplete: boolean
  /** Error message if recovery failed */
  error: string | null
  /** Whether recovery is in progress */
  loading: boolean
  /** Current character offset (for offset-based streaming) */
  offset: number
}

interface UseStreamingRecoveryOptions {
  /** Subtask ID to recover content for */
  subtaskId: number | null
  /** Subtask status */
  status: string | null
  /** Subtask role */
  role: string | null
  /** Team ID (required for offset-based streaming) */
  teamId?: number | null
  /** Whether to enable recovery */
  enabled?: boolean
  /** Callback when stream completes */
  onStreamComplete?: (subtaskId: number) => void
}

/**
 * Hook to recover streaming content for a subtask.
 *
 * @param options - Recovery options
 * @returns Recovery state
 */
export function useStreamingRecovery(options: UseStreamingRecoveryOptions): RecoveryState {
  const { subtaskId, status, role, teamId, enabled = true, onStreamComplete } = options

  const [recovery, setRecovery] = useState<RecoveryState>({
    recovered: false,
    content: '',
    source: null,
    streaming: false,
    incomplete: false,
    error: null,
    loading: false,
    offset: 0,
  })

  const abortRef = useRef<(() => void) | null>(null)

  const recoverContent = useCallback(async () => {
    if (!subtaskId || !enabled) return

    // Only recover for RUNNING status ASSISTANT messages
    if (status !== 'RUNNING' || role !== 'ASSISTANT') {
      return
    }

    setRecovery(prev => ({ ...prev, loading: true, error: null }))

    try {
      // 1. First, get cached content to determine current offset
      const result = await chatApis.getStreamingContent(subtaskId)
      const currentOffset = result.content?.length || 0

      if (result.content) {
        setRecovery({
          recovered: true,
          content: result.content,
          source: result.source,
          streaming: result.streaming,
          incomplete: result.incomplete,
          error: null,
          loading: false,
          offset: currentOffset,
        })

        // 2. If still streaming and we have teamId, resume via unified stream endpoint
        if (result.streaming && result.status === 'RUNNING' && teamId) {
          try {
            const { abort } = await chatApis.resumeStreamWithOffset(
              subtaskId,
              currentOffset,
              teamId,
              {
                onMessage: (data: ChatStreamData) => {
                  // Skip cached content - we already have it
                  if (data.cached) {
                    return
                  }

                  // Handle content updates (check for non-empty content)
                  if (
                    data.content !== undefined &&
                    data.content !== null &&
                    data.content.length > 0
                  ) {
                    // Append new content and update offset
                    const contentLength = data.content.length
                    setRecovery(prev => ({
                      ...prev,
                      content: prev.content + data.content,
                      streaming: !data.done,
                      offset:
                        data.offset !== undefined
                          ? data.offset + contentLength
                          : prev.offset + contentLength,
                    }))
                  }

                  // Handle stream completion (must be checked separately)
                  if (data.done) {
                    // Stream completed
                    setRecovery(prev => ({
                      ...prev,
                      streaming: false,
                    }))
                    abortRef.current = null

                    // Notify parent component to refresh task detail
                    if (onStreamComplete && subtaskId) {
                      onStreamComplete(subtaskId)
                    }
                  }

                  // Handle errors
                  if (data.error) {
                    console.error('Stream error:', data.error)
                    setRecovery(prev => ({
                      ...prev,
                      error: data.error || 'Unknown error',
                      streaming: false,
                    }))
                    abortRef.current = null

                    // Notify parent component to refresh task detail
                    if (onStreamComplete && subtaskId) {
                      onStreamComplete(subtaskId)
                    }
                  }
                },
                onError: (error: Error) => {
                  console.error('Stream error:', error)
                  setRecovery(prev => ({
                    ...prev,
                    error: error.message,
                    streaming: false,
                  }))
                  abortRef.current = null

                  // Notify parent component to refresh task detail
                  if (onStreamComplete && subtaskId) {
                    onStreamComplete(subtaskId)
                  }
                },
                onComplete: () => {
                  setRecovery(prev => ({
                    ...prev,
                    streaming: false,
                  }))
                  abortRef.current = null

                  // Notify parent component to refresh task detail
                  if (onStreamComplete && subtaskId) {
                    onStreamComplete(subtaskId)
                  }
                },
              }
            )
            abortRef.current = abort
          } catch (streamError) {
            console.error('Failed to resume stream:', streamError)
            // Don't set error - we still have the cached content
          }
        }
      } else {
        setRecovery({
          recovered: false,
          content: '',
          source: null,
          streaming: false,
          incomplete: false,
          error: null,
          loading: false,
          offset: 0,
        })
      }
    } catch (error) {
      console.error('Failed to recover streaming content:', error)
      setRecovery({
        recovered: false,
        content: '',
        source: null,
        streaming: false,
        incomplete: false,
        error: (error as Error).message,
        loading: false,
        offset: 0,
      })
    }
  }, [subtaskId, status, role, teamId, enabled, onStreamComplete])

  useEffect(() => {
    recoverContent()

    // Cleanup: abort stream on unmount
    return () => {
      if (abortRef.current) {
        abortRef.current()
        abortRef.current = null
      }
    }
  }, [recoverContent])

  return recovery
}

/**
 * Hook to recover streaming content for multiple subtasks.
 *
 * @param subtasks - Array of subtasks to check for recovery
 * @param teamId - Team ID (required for offset-based streaming)
 * @param onStreamComplete - Callback when stream completes
 * @param activeStreamingSubtaskId - ID of subtask currently being actively streamed (to skip recovery)
 * @returns Map of subtask ID to recovery state
 */
export function useMultipleStreamingRecovery(
  subtasks: Array<{ id: number; status: string; role: string }> | null,
  teamId?: number | null,
  onStreamComplete?: (subtaskId: number) => void,
  activeStreamingSubtaskId?: number | null
): Map<number, RecoveryState> {
  const [recoveryMap, setRecoveryMap] = useState<Map<number, RecoveryState>>(new Map())
  const abortFunctionsRef = useRef<Map<number, () => void>>(new Map())
  // Track which subtask IDs we've already started recovery for
  const recoveredSubtaskIdsRef = useRef<Set<number>>(new Set())

  useEffect(() => {
    if (!subtasks || subtasks.length === 0) return

    // Find RUNNING ASSISTANT subtasks that need recovery
    // Skip the subtask that is currently being actively streamed
    // Skip subtasks that we've already started recovery for
    const runningAssistants = subtasks.filter(
      sub =>
        sub.status === 'RUNNING' &&
        sub.role === 'ASSISTANT' &&
        sub.id !== activeStreamingSubtaskId &&
        !recoveredSubtaskIdsRef.current.has(sub.id)
    )

    console.log('[useMultipleStreamingRecovery] Checking subtasks:', {
      totalSubtasks: subtasks.length,
      runningAssistants: runningAssistants.map(s => ({ id: s.id, status: s.status })),
      activeStreamingSubtaskId,
      alreadyRecovered: Array.from(recoveredSubtaskIdsRef.current),
    })

    if (runningAssistants.length === 0) return

    const recoverAll = async () => {
      console.log(
        '[useMultipleStreamingRecovery] Starting recovery for:',
        runningAssistants.map(s => s.id)
      )

      // Mark these subtasks as being recovered to prevent duplicate recovery attempts
      runningAssistants.forEach(sub => recoveredSubtaskIdsRef.current.add(sub.id))

      // Create a new map to collect recovery states
      const newMap = new Map<number, RecoveryState>()

      for (const subtask of runningAssistants) {
        try {
          console.log('[useMultipleStreamingRecovery] Fetching content for subtask:', subtask.id)
          const result = await chatApis.getStreamingContent(subtask.id)
          console.log('[useMultipleStreamingRecovery] Got content for subtask:', subtask.id, {
            hasContent: !!result.content,
            contentLength: result.content?.length || 0,
            streaming: result.streaming,
            status: result.status,
          })
          const currentOffset = result.content?.length || 0

          // Set initial state even if content is empty - we'll start streaming from offset 0
          const initialState: RecoveryState = {
            recovered: true,
            content: result.content || '',
            source: result.source,
            streaming: result.streaming || result.status === 'RUNNING',
            incomplete: result.incomplete,
            error: null,
            loading: false,
            offset: currentOffset,
          }
          newMap.set(subtask.id, initialState)

          // Resume streaming if still RUNNING and we have teamId
          // Even if content is empty, we should try to resume streaming
          if ((result.streaming || result.status === 'RUNNING') && teamId) {
            try {
              const { abort } = await chatApis.resumeStreamWithOffset(
                subtask.id,
                currentOffset,
                teamId,
                {
                  onMessage: (data: ChatStreamData) => {
                    if (data.cached) return // Skip cached content

                    // Handle content updates (including empty string check with !== undefined)
                    if (
                      data.content !== undefined &&
                      data.content !== null &&
                      data.content.length > 0
                    ) {
                      const contentLength = data.content.length
                      setRecoveryMap(prev => {
                        const current = prev.get(subtask.id)
                        if (!current) return prev

                        const updated = new Map(prev)
                        updated.set(subtask.id, {
                          ...current,
                          content: current.content + data.content,
                          streaming: !data.done,
                          offset:
                            data.offset !== undefined
                              ? data.offset + contentLength
                              : current.offset + contentLength,
                        })
                        return updated
                      })
                    }

                    // Handle stream completion (must be checked separately, not inside content block)
                    if (data.done) {
                      setRecoveryMap(prev => {
                        const current = prev.get(subtask.id)
                        if (!current) return prev

                        const updated = new Map(prev)
                        updated.set(subtask.id, {
                          ...current,
                          streaming: false,
                        })
                        return updated
                      })
                      abortFunctionsRef.current.delete(subtask.id)

                      // Notify parent component to refresh task detail
                      if (onStreamComplete) {
                        onStreamComplete(subtask.id)
                      }
                    }

                    // Handle errors
                    if (data.error) {
                      setRecoveryMap(prev => {
                        const current = prev.get(subtask.id)
                        if (!current) return prev

                        const updated = new Map(prev)
                        updated.set(subtask.id, {
                          ...current,
                          streaming: false,
                          error: data.error || 'Unknown error',
                        })
                        return updated
                      })
                      abortFunctionsRef.current.delete(subtask.id)
                    }
                  },
                  onError: (error: Error) => {
                    console.error(`Stream error for subtask ${subtask.id}:`, error)
                    setRecoveryMap(prev => {
                      const current = prev.get(subtask.id)
                      if (!current) return prev

                      const updated = new Map(prev)
                      updated.set(subtask.id, {
                        ...current,
                        streaming: false,
                        error: error.message,
                      })
                      return updated
                    })
                    abortFunctionsRef.current.delete(subtask.id)

                    // Notify parent component to refresh task detail
                    if (onStreamComplete) {
                      onStreamComplete(subtask.id)
                    }
                  },
                  onComplete: () => {
                    setRecoveryMap(prev => {
                      const current = prev.get(subtask.id)
                      if (!current) return prev

                      const updated = new Map(prev)
                      updated.set(subtask.id, {
                        ...current,
                        streaming: false,
                      })
                      return updated
                    })
                    abortFunctionsRef.current.delete(subtask.id)

                    // Notify parent component to refresh task detail
                    if (onStreamComplete) {
                      onStreamComplete(subtask.id)
                    }
                  },
                }
              )
              abortFunctionsRef.current.set(subtask.id, abort)
            } catch (streamError) {
              console.error(`Failed to resume stream for subtask ${subtask.id}:`, streamError)
            }
          }
        } catch (error) {
          console.error(`Failed to recover content for subtask ${subtask.id}:`, error)
          newMap.set(subtask.id, {
            recovered: false,
            content: '',
            source: null,
            streaming: false,
            incomplete: false,
            error: (error as Error).message,
            loading: false,
            offset: 0,
          })
        }
      }

      // Merge new recovery states with existing ones
      setRecoveryMap(prev => {
        const merged = new Map(prev)
        runningAssistants.forEach(sub => {
          const state = newMap.get(sub.id)
          if (state) {
            merged.set(sub.id, state)
          }
        })
        return merged
      })
    }

    recoverAll()

    // Capture the current ref value for cleanup
    const currentAbortFunctions = abortFunctionsRef.current

    // Cleanup: abort all streams on unmount
    return () => {
      currentAbortFunctions.forEach(abort => abort())
      currentAbortFunctions.clear()
    }
  }, [subtasks, teamId, activeStreamingSubtaskId, onStreamComplete])

  // Clean up recovered subtask IDs when subtasks change (e.g., subtask completed)
  useEffect(() => {
    if (!subtasks) return

    const completedSubtaskIds: number[] = []

    // Find subtasks that are no longer RUNNING
    recoveredSubtaskIdsRef.current.forEach(id => {
      const subtask = subtasks.find(s => s.id === id)
      if (!subtask || subtask.status !== 'RUNNING') {
        completedSubtaskIds.push(id)
      }
    })

    // Remove completed subtasks from tracking
    completedSubtaskIds.forEach(id => {
      recoveredSubtaskIdsRef.current.delete(id)
      // Also remove from recoveryMap if the subtask is no longer RUNNING
      setRecoveryMap(prev => {
        const updated = new Map(prev)
        const subtask = subtasks.find(s => s.id === id)
        if (!subtask || subtask.status !== 'RUNNING') {
          updated.delete(id)
        }
        return updated
      })
    })
  }, [subtasks])

  return recoveryMap
}

export default useStreamingRecovery
