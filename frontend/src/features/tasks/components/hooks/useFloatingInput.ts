// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, useEffect, useCallback } from 'react';

export interface FloatingMetrics {
  /**
   * Width of the chat area container in pixels.
   */
  width: number;

  /**
   * Left offset of the chat area container in pixels.
   */
  left: number;
}

export interface UseFloatingInputOptions {
  /**
   * Whether there are messages to display.
   * Floating input is only shown when there are messages.
   */
  hasMessages: boolean;
}

export interface UseFloatingInputReturn {
  /**
   * Ref to attach to the chat area container element.
   * Used to measure position for floating input alignment.
   */
  chatAreaRef: React.RefObject<HTMLDivElement | null>;

  /**
   * Ref to attach to the floating input container element.
   * Used to measure height for scroll padding calculation.
   */
  floatingInputRef: React.RefObject<HTMLDivElement | null>;

  /**
   * Ref to attach to the input controls container element.
   * Used to measure width for responsive collapse detection.
   */
  inputControlsRef: React.RefObject<HTMLDivElement | null>;

  /**
   * Metrics for positioning the floating input.
   * Contains width and left offset of the chat area.
   */
  floatingMetrics: FloatingMetrics;

  /**
   * Height of the floating input in pixels.
   * Used to add padding to the scroll container.
   */
  inputHeight: number;

  /**
   * Width of the input controls container in pixels.
   * Used for responsive collapse detection.
   */
  controlsContainerWidth: number;
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
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const floatingInputRef = useRef<HTMLDivElement>(null);
  const inputControlsRef = useRef<HTMLDivElement>(null);

  const [floatingMetrics, setFloatingMetrics] = useState<FloatingMetrics>({
    width: 0,
    left: 0,
  });
  const [inputHeight, setInputHeight] = useState(0);
  const [controlsContainerWidth, setControlsContainerWidth] = useState(0);

  /**
   * Updates the floating metrics based on chat area dimensions.
   */
  const updateFloatingMetrics = useCallback(() => {
    if (!chatAreaRef.current) return;
    const rect = chatAreaRef.current.getBoundingClientRect();
    setFloatingMetrics({
      width: rect.width,
      left: rect.left,
    });
  }, []);

  /**
   * Effect: Observe controls container width for responsive collapse.
   *
   * This replaces the original useEffect at lines 189-203 in ChatArea.tsx.
   * Uses ResizeObserver to track width changes.
   */
  useEffect(() => {
    const element = inputControlsRef.current;
    if (!element) return;

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        setControlsContainerWidth(entry.contentRect.width);
      }
    });

    resizeObserver.observe(element);
    setControlsContainerWidth(element.clientWidth);

    return () => resizeObserver.disconnect();
  }, []);

  /**
   * Effect: Keep floating input aligned with chat area.
   *
   * This replaces the original useEffect at lines 440-468 in ChatArea.tsx.
   * Tracks chat area position and updates floating metrics.
   */
  useEffect(() => {
    if (!hasMessages) {
      setFloatingMetrics({ width: 0, left: 0 });
      return;
    }

    updateFloatingMetrics();
    window.addEventListener('resize', updateFloatingMetrics);

    let observer: ResizeObserver | null = null;
    if (chatAreaRef.current && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateFloatingMetrics);
      observer.observe(chatAreaRef.current);
    }

    return () => {
      window.removeEventListener('resize', updateFloatingMetrics);
      observer?.disconnect();
    };
  }, [hasMessages, updateFloatingMetrics]);

  /**
   * Effect: Measure floating input height.
   *
   * This replaces the original useEffect at lines 471-490 in ChatArea.tsx.
   * Tracks height changes for scroll padding calculation.
   */
  useEffect(() => {
    if (!hasMessages || !floatingInputRef.current) {
      setInputHeight(0);
      return;
    }

    const element = floatingInputRef.current;
    const updateHeight = () => setInputHeight(element.offsetHeight);

    updateHeight();

    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(updateHeight);
      resizeObserver.observe(element);
      return () => resizeObserver.disconnect();
    }

    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, [hasMessages]);

  return {
    chatAreaRef,
    floatingInputRef,
    inputControlsRef,
    floatingMetrics,
    inputHeight,
    controlsContainerWidth,
  };
}

export default useFloatingInput;
