// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { RiBrainLine } from 'react-icons/ri'
import { FiChevronDown, FiChevronUp } from 'react-icons/fi'
import { Button, Card } from 'antd'
import { useTranslation } from '@/hooks/useTranslation'

interface ThinkingItem {
  title: string
  action: string
  result?: string
  reasoning: string
  confidence?: number
  next_action: string
  value?: any
}

interface ThinkingComponentProps {
  thinking: ThinkingItem[] | null
  taskStatus?: string
}

export default function ThinkingComponent({ thinking, taskStatus }: ThinkingComponentProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartY, setDragStartY] = useState(0);
  const [dragCurrentY, setDragCurrentY] = useState(0);
  const [translateY, setTranslateY] = useState(0);
  const [modalWidth, setModalWidth] = useState<number | null>(null);
  const [modalCenterX, setModalCenterX] = useState<number | null>(null);
  
  // Scroll-related states
  const [hasScrolled, setHasScrolled] = useState(false);
  const [mouseMoved, setMouseMoved] = useState(false);
  const [hasTextSelection, setHasTextSelection] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [updateCount, setUpdateCount] = useState(0);
  
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation('chat');
  
  // Used to track previous thinking content to detect real changes
  const prevThinkingLengthRef = useRef<number>(0);
  
  // Scroll threshold
  const SCROLL_THRESHOLD = 24;

  // Function to check if at bottom
  const isAtBottom = useCallback((element: HTMLElement): boolean => {
    const { scrollHeight, scrollTop, clientHeight } = element;
    return scrollHeight - (scrollTop + clientHeight) <= SCROLL_THRESHOLD;
  }, []);

  // Function to scroll to bottom
  const scrollToBottom = useCallback((element: HTMLElement) => {
    element.scrollTo({
      top: element.scrollHeight,
      behavior: 'smooth'
    });
  }, []);

  // Handle scroll event
  const handleScroll = useCallback((e: Event) => {
    const target = e.target as HTMLElement;
    
    // Mark user as scrolled
    if (!isAtBottom(target)) {
      setHasScrolled(true);
    }
    
    // If scrolled back to bottom, clear update notification
    if (isAtBottom(target)) {
      setHasUpdate(false);
      setUpdateCount(0);
    }
  }, [isAtBottom]);

  // Handle mouse move event
  const handleMouseMove = useCallback(() => {
    if (!mouseMoved) {
      setMouseMoved(true);
    }
  }, [mouseMoved]);

  // Handle text selection change event
  // Handle text selection change event
  const handleSelectionChange = useCallback(() => {
    if (typeof window !== 'undefined' && window.getSelection) {
      const selection = window.getSelection();
      setHasTextSelection((selection?.toString() || '').length > 0);
    }
  }, []);
  // Handle update button click
  const handleUpdateButtonClick = useCallback(() => {
    if (contentRef.current) {
      scrollToBottom(contentRef.current);
      setHasUpdate(false);
      setUpdateCount(0);
    }
  }, [scrollToBottom]);

  // Get corresponding text based on key
  const getThinkingText = (key: string): string => {
    if (!key) return '';
    
    // Check if the string contains template variables like ${thinking.xxx}
    const templateRegex = /\$\{([^}]+)\}/g;
    let match;
    let result = key;
    
    // Replace all template variables
    while ((match = templateRegex.exec(key)) !== null) {
      const templateKey = match[1];
      // If the template key contains dots, it's an i18n key
      if (templateKey.includes('.')) {
        const translatedText = t(templateKey) || templateKey;
        result = result.replace(match[0], translatedText);
      } else {
        // Keep the original template if it's not an i18n key
        result = result.replace(match[0], templateKey);
      }
    }
    
    // If no templates were found, check if the entire string is an i18n key (for backward compatibility)
    if (result === key) {
      // If key contains dots, it's an i18n key
      if (key.includes('.')) {
        return t(key) || key;
      }
    }
    
    // Return the processed result
    return result;
  };

  console.log('ThinkingComponent received:', thinking);
  console.log('Task status:', taskStatus);
  
  // Check if thinking is completed based on task status and thinking data
  const isThinkingCompleted = (taskStatus === 'COMPLETED' || taskStatus === 'FAILED') ||
    (thinking && thinking.length > 0 &&
    thinking.some(item => {
      console.log('Thinking item:', item);
      return item.value !== null && item.value !== undefined && item.value !== '';
    }));
  
  // Check if task is in progress
  const isTaskInProgress = taskStatus === 'RUNNING' || taskStatus === 'PENDING' || taskStatus === 'PROCESSING';

  // Detect mobile device
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768 || /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent));
    };
    
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);
  
  // Close dropdown when clicking outside (desktop only)
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Element;
      // Only close on desktop when clicking outside, and not on update button
      if (
        !isMobile &&
        isExpanded &&
        !target.closest('.thinking-component') &&
        !target.closest('.thinking-modal') &&
        !target.closest('[data-thinking-update-button]')
      ) {
        setIsExpanded(false);
      }
    };

    if (isExpanded) {
      document.addEventListener('click', handleClickOutside);
    }

    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [isExpanded, isMobile]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const computeDimensions = () => {
      const fallbackMaxWidth = 768; // matches Tailwind's max-w-3xl
      const sidePadding = 32;
      const triggerElement = triggerRef.current;
      const chatContainer = triggerElement?.closest('[data-chat-container]') as HTMLElement | null;
      let measuredWidth = fallbackMaxWidth;
      let centerX = typeof window !== 'undefined' ? window.innerWidth / 2 : fallbackMaxWidth / 2;

      if (chatContainer) {
        const rect = chatContainer.getBoundingClientRect();
        measuredWidth = rect.width;
        centerX = rect.left + rect.width / 2;
      }

      const viewportAllowance = window.innerWidth > sidePadding
        ? window.innerWidth - sidePadding
        : window.innerWidth;

      if (viewportAllowance > 0) {
        measuredWidth = Math.min(measuredWidth, viewportAllowance);
      }

      const halfWidth = measuredWidth / 2;
      const minMargin = sidePadding / 2;
      if (centerX - halfWidth < minMargin) {
        centerX = halfWidth + minMargin;
      } else if (centerX + halfWidth > window.innerWidth - minMargin) {
        centerX = window.innerWidth - halfWidth - minMargin;
      }

      setModalWidth(measuredWidth);
      setModalCenterX(centerX);
    };

    computeDimensions();
    window.addEventListener('resize', computeDimensions);

    const chatContainer = triggerRef.current?.closest('[data-chat-container]') as HTMLElement | null;
    let resizeObserver: ResizeObserver | null = null;

    if (chatContainer && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => computeDimensions());
      resizeObserver.observe(chatContainer);
    }

    return () => {
      window.removeEventListener('resize', computeDimensions);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
    };
  }, []);

  // Handle ESC key to close expanded panel
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isExpanded) {
        setIsExpanded(false);
      }
    };

    if (isExpanded) {
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isExpanded]);

  // Handle drag start
  const handleDragStart = (e: React.TouchEvent | React.MouseEvent) => {
    if (!isMobile) return;

    setIsDragging(true);
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    setDragStartY(clientY);
    setDragCurrentY(clientY);

    // Prevent default to avoid scrolling
    if ('touches' in e) {
      e.preventDefault();
    }
  };

  // Handle drag move
  const handleDragMove = (e: React.TouchEvent | React.MouseEvent) => {
    if (!isDragging || !isMobile) return;

    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    setDragCurrentY(clientY);

    const deltaY = clientY - dragStartY;
    if (deltaY > 0) {
      setTranslateY(deltaY);
    }
  };

  // Handle drag end
  const handleDragEnd = () => {
    if (!isDragging || !isMobile) return;

    setIsDragging(false);

    // If dragged down more than 100px, close the panel
    if (translateY > 100) {
      setIsExpanded(false);
    }

    // Reset translation
    setTranslateY(0);
    setDragStartY(0);
    setDragCurrentY(0);
  };

  // Add global touch/mouse event listeners for dragging
  useEffect(() => {
    if (!isDragging || !isMobile) return;

    const handleMove = (e: TouchEvent | MouseEvent) => {
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
      setDragCurrentY(clientY);

      const deltaY = clientY - dragStartY;
      if (deltaY > 0) {
        setTranslateY(deltaY);
      }
    };

    const handleEnd = () => {
      setIsDragging(false);

      // If dragged down more than 100px, close the panel
      if (translateY > 100) {
        setIsExpanded(false);
      }

      // Reset translation
      setTranslateY(0);
      setDragStartY(0);
      setDragCurrentY(0);
    };

    if ('touches' in navigator) {
      document.addEventListener('touchmove', handleMove, { passive: false });
      document.addEventListener('touchend', handleEnd);
    } else {
      document.addEventListener('mousemove', handleMove);
      document.addEventListener('mouseup', handleEnd);
    }

    return () => {
      if ('touches' in navigator) {
        document.removeEventListener('touchmove', handleMove);
        document.removeEventListener('touchend', handleEnd);
      } else {
        document.removeEventListener('mousemove', handleMove);
        document.removeEventListener('mouseup', handleEnd);
      }
    };
  }, [isDragging, isMobile, dragStartY, translateY]);

  // Auto-scroll logic when content updates
  useEffect(() => {
    if (!isExpanded || !contentRef.current || !thinking) return;

    const currentLength = thinking.length;
    const prevLength = prevThinkingLengthRef.current;

    // Only process when content actually increases (new items added)
    if (currentLength <= prevLength) {
      prevThinkingLengthRef.current = currentLength;
      return;
    }

    prevThinkingLengthRef.current = currentLength;

    const element = contentRef.current;
    const atBottom = isAtBottom(element);

    // Determine if should auto-scroll
    const shouldAutoScroll =
      atBottom &&                    // At bottom
      !hasScrolled &&                // Never scrolled
      !mouseMoved &&                 // Mouse not moved
      !hasTextSelection;             // No text selected

    if (shouldAutoScroll) {
      // Silent follow: auto-scroll to bottom
      scrollToBottom(element);
    } else if (!atBottom && hasScrolled) {
      // Show update notification only after user leaves bottom
      setHasUpdate(true);
      setUpdateCount(prev => prev + 1);
    }
  }, [thinking, isExpanded, isAtBottom, hasScrolled, mouseMoved, hasTextSelection, scrollToBottom]);

  // Manage event listeners
  useEffect(() => {
    if (!isExpanded) {
      // Reset all states when panel is closed
      setHasScrolled(false);
      setMouseMoved(false);
      setHasTextSelection(false);
      setHasUpdate(false);
      setUpdateCount(0);
      prevThinkingLengthRef.current = 0;
      return;
    }

    // Initialize thinking length when panel is opened
    if (thinking) {
      prevThinkingLengthRef.current = thinking.length;
    }

    // When panel is opened: initial scroll to bottom
    if (contentRef.current) {
      // Use setTimeout to ensure DOM updates are complete before scrolling
      setTimeout(() => {
        if (contentRef.current) {
          scrollToBottom(contentRef.current);
        }
      }, 100);
    }

    // Add event listeners
    const element = contentRef.current;
    if (element) {
      element.addEventListener('scroll', handleScroll);
      element.addEventListener('mousemove', handleMouseMove);
    }
    document.addEventListener('selectionchange', handleSelectionChange);

    // Cleanup function
    return () => {
      if (element) {
        element.removeEventListener('scroll', handleScroll);
        element.removeEventListener('mousemove', handleMouseMove);
      }
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [isExpanded, handleScroll, handleMouseMove, handleSelectionChange, scrollToBottom]);

  if (!thinking || thinking.length === 0) {
    console.log('ThinkingComponent: No thinking data or empty array');
    return null;
  }

  // Desktop view
  if (!isMobile) {
    return (
      <div ref={triggerRef} className="relative z-20 thinking-component ml-2 flex items-center">
        <Button
          type="text"
          size="small"
          icon={<RiBrainLine className="w-4 h-4" />}
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded(!isExpanded);
          }}
          className="flex items-center gap-1 text-xs bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded-md px-2 py-1"
        >
          <span className={`hidden sm:inline ${isTaskInProgress ? 'thinking-text-flow-text' : ''}`}>
            {isThinkingCompleted ? (t('messages.thinking_completed') || 'Thinking Completed') : (t('messages.thinking') || 'Thinking')}
          </span>
          {isExpanded ? <FiChevronUp className="w-3 h-3" /> : <FiChevronDown className="w-3 h-3" />}
        </Button>

        {isExpanded && createPortal(
          <>
            <div
              ref={contentRef}
              className={`thinking-modal fixed top-1/2 max-h-[70vh] sm:max-h-[80vh] overflow-y-auto bg-surface border border-border rounded-lg shadow-lg p-4 ${hasUpdate ? 'pb-16' : ''}`}
              style={{
                zIndex: 9999,
                // iOS Safari specific fix for stacking context issues
                transform: 'translate(-50%, -50%) translateZ(0)',
                WebkitTransform: 'translate(-50%, -50%) translateZ(0)',
                // Ensure proper positioning on iOS
                position: 'fixed',
                // Fix for iOS viewport issues
                maxHeight: '-webkit-fill-available',
                width: modalWidth ? `${modalWidth}px` : undefined,
                maxWidth: 'calc(100vw - 32px)',
                left: modalCenterX ? `${modalCenterX}px` : '50%'
              }}
            >
              <div className={`font-semibold text-sm mb-3 text-blue-400 ${isTaskInProgress ? 'thinking-text-flow-text' : ''}`}>{t('messages.thinking_process') || 'Thinking Process'}</div>
              {thinking.map((item, index) => (
                <Card key={index} size="small" className="mb-2 sm:mb-3 bg-surface/50 border border-border/50">
                  <div className="text-xs font-medium text-blue-300 mb-1">{getThinkingText(item.title)}</div>
                  <div className="text-xs text-text-secondary mb-1 sm:mb-2">{getThinkingText(item.action)}</div>
                  {item.result && (
                    <div className="text-xs text-text-tertiary mb-1 sm:mb-2">
                      <span className="font-medium">{t('messages.result') || 'Result'}: </span>
                      {getThinkingText(item.result)}
                    </div>
                  )}
                  <div className="text-xs text-text-tertiary mb-2">
                    <span className="font-medium">{t('messages.reasoning') || 'Reasoning'}: </span>
                    {getThinkingText(item.reasoning)}
                  </div>
                  <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-1 sm:gap-0">
                    {(item.confidence !== undefined && item.confidence >= 0) && (
                      <div className="text-xs text-text-tertiary">
                        <span className="font-medium">{t('messages.confidence') || 'Confidence'}: </span>
                        {Math.round(item.confidence * 100)}%
                      </div>
                    )}
                    <div className="text-xs px-2 py-1 rounded bg-blue-500/10 text-blue-400 text-right sm:ml-auto">
                      {getThinkingText(item.next_action)}
                    </div>
                  </div>
                </Card>
              ))}
            </div>

            {/* Desktop update button - floating centered and won't close panel */}
            {hasUpdate && contentRef.current && !isAtBottom(contentRef.current) && createPortal(
              <div data-thinking-update-button className="sticky bottom-2 w-full flex justify-center z-10 pointer-events-none">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUpdateButtonClick();
                  }}
                  className="pointer-events-auto bg-blue-500 text-white px-4 py-2 rounded-full shadow-lg hover:bg-blue-600 transition-colors flex items-center gap-2"
                >
                  <FiChevronDown className="w-4 h-4" />
                  {updateCount > 0 && (
                    <span className="text-xs">{t('thinking.new_content') || 'New content available'}</span>
                  )}
                </button>
              </div>,
              contentRef.current
            )}
          </>,
          document.body
        )}
      </div>
    );
  }

  // Mobile view
  return (
    <>
      <div ref={triggerRef} className="relative z-20 thinking-component ml-2 flex items-center">
        <Button
          type="text"
          size="small"
          icon={<RiBrainLine className="w-4 h-4" />}
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded(!isExpanded);
          }}
          className="flex items-center gap-1 text-xs bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded-md px-2 py-1"
        >
          <span className={isTaskInProgress ? 'thinking-text-flow-text' : ''}>
            {isThinkingCompleted ? (t('messages.thinking_completed') || 'Thinking Completed') : (t('messages.thinking') || 'Thinking')}
          </span>
          {isExpanded ? <FiChevronUp className="w-3 h-3" /> : <FiChevronDown className="w-3 h-3" />}
        </Button>
      </div>

      {isExpanded && createPortal(
        <>
          {/* Backdrop */}
          <div 
            className="fixed inset-0 bg-black/50 z-[99999] transition-opacity duration-300"
            onClick={() => setIsExpanded(false)}
          />
          
          {/* Mobile panel from bottom */}
          <div
            ref={panelRef}
            className="fixed bottom-0 left-0 right-0 bg-surface border-t border-border rounded-t-2xl shadow-2xl z-[100000] overflow-hidden"
            style={{
              height: '66.67vh', // 2/3 of viewport height
              transform: `translateY(${isDragging ? translateY : 0}px) translateZ(0)`,
              WebkitTransform: `translateY(${isDragging ? translateY : 0}px) translateZ(0)`,
              transition: isDragging ? 'none' : 'transform 0.3s ease-out',
            }}
          >
            {/* Drag handle */}
            <div
              className="flex justify-center pt-2 pb-1 cursor-grab active:cursor-grabbing"
              onTouchStart={handleDragStart}
              onMouseDown={handleDragStart}
            >
              <div className="w-12 h-1 bg-gray-300 dark:bg-gray-600 rounded-full"></div>
            </div>
            
            {/* Content */}
            <div
              ref={contentRef}
              className="h-full overflow-y-auto px-4 pb-4"
            >
              <div className={`font-semibold text-sm mb-3 text-blue-400 ${isTaskInProgress ? 'thinking-text-flow-text' : ''}`}>{t('messages.thinking_process') || 'Thinking Process'}</div>
              {thinking.map((item, index) => (
                <Card key={index} size="small" className="mb-3 bg-surface/50 border border-border/50">
                  <div className="text-sm font-medium text-blue-300 mb-1">{getThinkingText(item.title)}</div>
                  <div className="text-sm text-text-secondary mb-2">{getThinkingText(item.action)}</div>
                  {item.result && (
                    <div className="text-sm text-text-tertiary mb-2">
                      <span className="font-medium">{t('messages.result') || 'Result'}: </span>
                      {getThinkingText(item.result)}
                    </div>
                  )}
                  <div className="text-sm text-text-tertiary mb-2">
                    <span className="font-medium">{t('messages.reasoning') || 'Reasoning'}: </span>
                    {getThinkingText(item.reasoning)}
                  </div>
                  <div className="flex flex-col gap-2">
                    {(item.confidence !== undefined && item.confidence >= 0) && (
                      <div className="text-sm text-text-tertiary">
                        <span className="font-medium">{t('messages.confidence') || 'Confidence'}: </span>
                        {Math.round(item.confidence * 100)}%
                      </div>
                    )}
                    <div className="text-sm px-2 py-1 rounded bg-blue-500/10 text-blue-400 text-right">
                      {getThinkingText(item.next_action)}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
            
            {/* Mobile update button - positioned relative to content container */}
            {hasUpdate && contentRef.current && !isAtBottom(contentRef.current) && createPortal(
              <button
                onClick={handleUpdateButtonClick}
                className="sticky bottom-4 left-full -ml-20 bg-blue-500 text-white px-4 py-2 rounded-full shadow-lg hover:bg-blue-600 transition-colors flex items-center gap-2 z-10"
              >
                <FiChevronDown className="w-4 h-4" />
                {updateCount > 0 && (
                  <span className="text-xs">{t('thinking.new_content') || `new content updates`}</span>
                )}
              </button>,
              contentRef.current
            )}
          </div>
        </>,
        document.body
      )}
    </>
  );
}
