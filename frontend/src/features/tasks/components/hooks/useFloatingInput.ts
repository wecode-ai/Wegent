// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, useEffect, useCallback, useMemo } from 'react'

export interface FloatingMetrics {
  /**
   * Width of the chat area container in pixels.
   */
  width: number

  /**
   * Left offset of the chat area container in pixels.
   */
  left: number
}

export interface UseFloatingInputOptions {
  /**
   * Whether there are messages to display.
   * Floating input is only shown when there are messages.
   */
  hasMessages: boolean
}

export interface UseFloatingInputReturn {
  /**
   * Ref to attach to the chat area container element.
   * Used to measure position for floating input alignment.
   */
  chatAreaRef: React.RefObject<HTMLDivElement | null>

  /**
   * Ref to attach to the floating input container element.
   * Used to measure height for scroll padding calculation.
   */
  floatingInputRef: React.RefObject<HTMLDivElement | null>

  /**
   * Ref to attach to the input controls container element.
   * Used to measure width for responsive collapse detection.
   */
  inputControlsRef: React.RefObject<HTMLDivElement | null>

  /**
   * Metrics for positioning the floating input.
   * Contains width and left offset of the chat area.
   */
  floatingMetrics: FloatingMetrics

  /**
   * Height of the floating input in pixels.
   * Used to add padding to the scroll container.
   */
  inputHeight: number

  /**
   * Width of the input controls container in pixels.
   * Used for responsive collapse detection.
   */
  controlsContainerWidth: number
}

/**
 * useFloatingInput Hook
 *
 * Consolidates all floating input positioning logic for the ChatArea component:
 * - Tracking chat area dimensions for floating input alignment
 * - Measuring floating input height for scroll padding
 * - Measuring controls container width for responsive collapse
 *
 * This hook extracts multiple useEffect calls from ChatArea into a single,
 * cohesive unit that manages floating input positioning.
 */
export function useFloatingInput({ hasMessages }: UseFloatingInputOptions): UseFloatingInputReturn {
  const chatAreaRef = useRef<HTMLDivElement>(null)
  const floatingInputRef = useRef<HTMLDivElement>(null)
  const inputControlsRef = useRef<HTMLDivElement>(null)

  // Track previous hasMessages state to detect transitions
  const prevHasMessagesRef = useRef(hasMessages)

  const [floatingMetrics, setFloatingMetrics] = useState<FloatingMetrics>({
    width: 0,
    left: 0,
  })
  const [inputHeight, setInputHeight] = useState(0)
  const [controlsContainerWidth, setControlsContainerWidth] = useState(0)

  /**
   * Updates the floating metrics based on chat area dimensions.
   * Returns the new metrics for immediate use.
   */
  const updateFloatingMetrics = useCallback((): FloatingMetrics => {
    if (!chatAreaRef.current) return { width: 0, left: 0 }
    const rect = chatAreaRef.current.getBoundingClientRect()
    const newMetrics = {
      width: rect.width,
      left: rect.left,
    }
    setFloatingMetrics(newMetrics)
    return newMetrics
  }, [])

  // Update ref for next render
  prevHasMessagesRef.current = hasMessages

  // Compute effective metrics: when hasMessages is true but state hasn't updated yet,
  // synchronously read from DOM to prevent the "flash" where width is 0 for one frame
  const effectiveFloatingMetrics = useMemo((): FloatingMetrics => {
    // If we have valid metrics from state, use them
    if (floatingMetrics.width > 0) {
      return floatingMetrics
    }
    // If hasMessages is true but metrics are still 0, try to read from DOM synchronously
    if (hasMessages && chatAreaRef.current) {
      const rect = chatAreaRef.current.getBoundingClientRect()
      if (rect.width > 0) {
        return { width: rect.width, left: rect.left }
      }
    }
    // Fallback to state (which may be 0)
    return floatingMetrics
  }, [hasMessages, floatingMetrics])

  /**
   * Effect: Observe controls container width for responsive collapse.
   *
   * This replaces the original useEffect at lines 189-203 in ChatArea.tsx.
   * Uses ResizeObserver to track width changes.
   */
  useEffect(() => {
    const element = inputControlsRef.current
    if (!element) return

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        setControlsContainerWidth(entry.contentRect.width)
      }
    })

    resizeObserver.observe(element)
    setControlsContainerWidth(element.clientWidth)

    return () => resizeObserver.disconnect()
  }, [])

  /**
   /**
    * Effect: Keep floating input aligned with chat area.
    *
    * This replaces the original useEffect at lines 440-468 in ChatArea.tsx.
    * Tracks chat area position and updates floating metrics.
    * Always track metrics regardless of hasMessages to avoid position jumps.
    */
  useEffect(() => {
    // Always update metrics when chatAreaRef is available
    // This prevents position jumps when transitioning to hasMessages state
    updateFloatingMetrics()
    window.addEventListener('resize', updateFloatingMetrics)

    let observer: ResizeObserver | null = null
    if (chatAreaRef.current && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateFloatingMetrics)
      observer.observe(chatAreaRef.current)
    }

    return () => {
      window.removeEventListener('resize', updateFloatingMetrics)
      observer?.disconnect()
    }
  }, [updateFloatingMetrics])
  /**
   * Effect: Measure floating input height.
   *
   * This replaces the original useEffect at lines 471-490 in ChatArea.tsx.
   * Tracks height changes for scroll padding calculation.
   */
  useEffect(() => {
    if (!hasMessages || !floatingInputRef.current) {
      setInputHeight(0)
      return
    }

    const element = floatingInputRef.current
    const updateHeight = () => setInputHeight(element.offsetHeight)

    updateHeight()

    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(updateHeight)
      resizeObserver.observe(element)
      return () => resizeObserver.disconnect()
    }

    window.addEventListener('resize', updateHeight)
    return () => window.removeEventListener('resize', updateHeight)
  }, [hasMessages])

  return {
    chatAreaRef,
    floatingInputRef,
    inputControlsRef,
    floatingMetrics: effectiveFloatingMetrics,
    inputHeight,
    controlsContainerWidth,
  }
}

export default useFloatingInput
