// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useRef, useLayoutEffect, useMemo } from 'react'
import type { ThinkingStep, ScrollState } from '../types'
import { extractToolCalls, isTerminalStatus, isRunningStatus } from '../utils/thinkingUtils'
import { SCROLL_THRESHOLD } from '../utils/constants'

interface UseThinkingStateOptions {
  thinking: ThinkingStep[] | null
  taskStatus?: string
}

interface UseThinkingStateReturn {
  /** Memoized thinking items */
  items: ThinkingStep[]
  /** Whether the thinking panel is open */
  isOpen: boolean
  /** Set the open state */
  setIsOpen: (open: boolean) => void
  /** Toggle open state */
  toggleOpen: () => void
  /** Whether thinking is in a terminal state */
  isCompleted: boolean
  /** Whether task is currently running */
  isRunning: boolean
  /** Tool usage counts */
  toolCounts: Record<string, number>
  /** Total tool count */
  toolCount: number
  /** Ref for scroll container */
  contentRef: React.RefObject<HTMLDivElement | null>
  /** Whether to show scroll to bottom button */
  showScrollToBottom: boolean
  /** Handler for scroll to bottom button */
  handleScrollToBottom: () => void
  /** Expanded params state for collapsible content */
  expandedParams: Set<string>
  /** Toggle param expansion */
  toggleParamExpansion: (paramKey: string) => void
}

/**
 * Hook to manage thinking display state including:
 * - Open/collapsed state with auto-collapse on completion
 * - Scroll management with auto-scroll and manual override
 * - Tool usage statistics
 * - Collapsible content state
 */
export function useThinkingState({
  thinking,
  taskStatus,
}: UseThinkingStateOptions): UseThinkingStateReturn {
  // Filter out consecutive duplicate reasoning steps
  // This fixes the issue where refreshing during streaming shows multiple
  // "💭 Model Thinking" entries because each reasoning chunk creates a new step
  const items = useMemo(() => {
    if (!thinking) return []

    const filtered = thinking.filter((step, index) => {
      // Check if this is a reasoning type step
      const isReasoningStep = step.details?.type === 'reasoning'
      if (isReasoningStep && index > 0) {
        // Check if previous step was also a reasoning step - if so, skip this one
        const prevStep = thinking[index - 1]
        if (prevStep?.details?.type === 'reasoning') {
          return false
        }
      }
      return true
    })

    return filtered
  }, [thinking])

  // Calculate derived state
  const isCompleted = isTerminalStatus(taskStatus)
  const isRunning = isRunningStatus(taskStatus)
  const toolCounts = useMemo(() => extractToolCalls(items), [items])
  const toolCount = Object.values(toolCounts).reduce((sum, count) => sum + count, 0)

  // Initialize isOpen based on taskStatus
  const shouldBeCollapsed = isCompleted
  const [isOpen, setIsOpen] = useState(!shouldBeCollapsed)

  // Track previous state for auto-collapse
  const previousSignatureRef = useRef<string | null>(null)
  const userCollapsedRef = useRef(false)
  const previousStatusRef = useRef<string | undefined>(taskStatus)

  // Collapsible content state
  const [expandedParams, setExpandedParams] = useState<Set<string>>(new Set())

  // Scroll management
  const contentRef = useRef<HTMLDivElement | null>(null)
  const scrollStateRef = useRef<ScrollState>({
    scrollTop: 0,
    scrollHeight: 0,
    isUserScrolling: false,
  })
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

  // Auto-expand when new items arrive
  useEffect(() => {
    const signature = JSON.stringify(items)
    if (
      previousSignatureRef.current !== null &&
      previousSignatureRef.current !== signature &&
      !userCollapsedRef.current
    ) {
      setIsOpen(true)
    }
    previousSignatureRef.current = signature
  }, [items])

  // Auto-collapse when status changes to terminal state
  useEffect(() => {
    if (isCompleted && previousStatusRef.current !== taskStatus) {
      setIsOpen(false)
      userCollapsedRef.current = false
    }
    previousStatusRef.current = taskStatus
  }, [taskStatus, isCompleted])

  // Handle scroll events
  useEffect(() => {
    const container = contentRef.current
    if (!container || !isOpen) return

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      const isNearBottom = distanceFromBottom <= SCROLL_THRESHOLD

      scrollStateRef.current = {
        scrollTop,
        scrollHeight,
        isUserScrolling: !isNearBottom,
      }

      setShowScrollToBottom(distanceFromBottom > SCROLL_THRESHOLD)
    }

    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [isOpen])

  // Handle new content and auto-scroll
  useLayoutEffect(() => {
    const container = contentRef.current
    if (!container || !isOpen) return

    const previous = scrollStateRef.current
    const { scrollTop, scrollHeight, clientHeight } = container
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    const isNearBottom = distanceFromBottom <= SCROLL_THRESHOLD

    if (!previous.isUserScrolling || isNearBottom) {
      container.scrollTop = container.scrollHeight
      setShowScrollToBottom(false)
    } else if (scrollHeight > previous.scrollHeight) {
      setShowScrollToBottom(true)
    }

    scrollStateRef.current = {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      isUserScrolling: previous.isUserScrolling && !isNearBottom,
    }
  }, [items, isOpen])

  // Toggle handler that tracks user preference
  const toggleOpen = () => {
    setIsOpen(prev => {
      const next = !prev
      userCollapsedRef.current = !next
      return next
    })
  }

  // Scroll to bottom handler
  const handleScrollToBottom = () => {
    const container = contentRef.current
    if (!container) return

    container.scrollTop = container.scrollHeight
    scrollStateRef.current.isUserScrolling = false
    setShowScrollToBottom(false)
  }

  // Toggle param expansion
  const toggleParamExpansion = (paramKey: string) => {
    setExpandedParams(prev => {
      const newSet = new Set(prev)
      if (newSet.has(paramKey)) {
        newSet.delete(paramKey)
      } else {
        newSet.add(paramKey)
      }
      return newSet
    })
  }

  return {
    items,
    isOpen,
    setIsOpen,
    toggleOpen,
    isCompleted,
    isRunning,
    toolCounts,
    toolCount,
    contentRef,
    showScrollToBottom,
    handleScrollToBottom,
    expandedParams,
    toggleParamExpansion,
  }
}
