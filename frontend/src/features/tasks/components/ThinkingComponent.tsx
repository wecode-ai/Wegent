// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useRef } from 'react'
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
  const panelRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation('chat');

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
      // Only close on desktop when clicking outside
      if (!isMobile && isExpanded && !target.closest('.thinking-component') && !target.closest('.thinking-modal')) {
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
  
  if (!thinking || thinking.length === 0) {
    console.log('ThinkingComponent: No thinking data or empty array');
    return null;
  }

  // Desktop view
  if (!isMobile) {
    return (
      <div className="absolute top-2 right-2 z-20 thinking-component">
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
          <div
            className="thinking-modal fixed top-1/2 left-1/2 w-80 sm:w-96 max-w-[90vw] max-h-[70vh] sm:max-h-96 overflow-y-auto bg-surface border border-border rounded-lg shadow-lg p-4"
            style={{
              zIndex: 9999,
              // iOS Safari specific fix for stacking context issues
              transform: 'translate(-50%, -50%) translateZ(0)',
              WebkitTransform: 'translate(-50%, -50%) translateZ(0)',
              // Ensure proper positioning on iOS
              position: 'fixed',
              // Fix for iOS viewport issues
              maxHeight: '-webkit-fill-available'
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
          </div>,
          document.body
        )}
      </div>
    );
  }

  // Mobile view
  return (
    <>
      <div className="absolute top-2 right-2 z-20 thinking-component">
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
              <div className="w-10 h-1 bg-gray-400 rounded-full"></div>
            </div>
            
            {/* Content */}
            <div className="h-full overflow-y-auto px-4 pb-4">
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
          </div>
        </>,
        document.body
      )}
    </>
  );
}