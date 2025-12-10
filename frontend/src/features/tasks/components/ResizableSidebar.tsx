// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect, useRef, ReactNode } from 'react';

interface ResizableSidebarProps {
  children: ReactNode;
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
  storageKey?: string;
  isCollapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export default function ResizableSidebar({
  children,
  minWidth = 200,
  maxWidth = 500,
  defaultWidth = 244, // 增加 20px，原来是 224px
  storageKey = 'task-sidebar-width',
  isCollapsed = false,
  onToggleCollapsed,
}: ResizableSidebarProps) {
  const COLLAPSED_WIDTH = 60;
  const AUTO_COLLAPSE_THRESHOLD = 80;
  const SIDEBAR_MARGIN_X = 8; // Match CSS variable --sidebar-margin-x
  const SIDEBAR_MARGIN_Y = 6; // Match CSS variable --sidebar-margin-y

  // Initialize width based on collapsed state and saved width
  // This runs synchronously to avoid flash of incorrect width
  const getInitialWidth = () => {
    if (typeof window === 'undefined') {
      return isCollapsed ? COLLAPSED_WIDTH : defaultWidth;
    }
    if (isCollapsed) {
      return COLLAPSED_WIDTH;
    }
    const savedWidth = localStorage.getItem(storageKey);
    if (savedWidth) {
      const width = parseInt(savedWidth, 10);
      if (width >= minWidth && width <= maxWidth) {
        return width;
      }
    }
    return defaultWidth;
  };

  // Get initial expanded width from localStorage
  const getInitialExpandedWidth = () => {
    if (typeof window === 'undefined') return defaultWidth;
    const savedWidth = localStorage.getItem(storageKey);
    if (savedWidth) {
      const width = parseInt(savedWidth, 10);
      if (width >= minWidth && width <= maxWidth) {
        return width;
      }
    }
    return defaultWidth;
  };

  const [sidebarWidth, setSidebarWidth] = useState(getInitialWidth);
  const [isResizing, setIsResizing] = useState(false);
  // Track if initial render is complete to enable transitions
  const [isInitialized, setIsInitialized] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(sidebarWidth);
  const lastExpandedWidthRef = useRef<number>(getInitialExpandedWidth());

  // Enable transitions after initial render
  useEffect(() => {
    // Use requestAnimationFrame to ensure the initial render is complete
    const frame = requestAnimationFrame(() => {
      setIsInitialized(true);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // Keep widthRef in sync with sidebarWidth
  useEffect(() => {
    widthRef.current = sidebarWidth;
    if (!isCollapsed && sidebarWidth > AUTO_COLLAPSE_THRESHOLD) {
      lastExpandedWidthRef.current = sidebarWidth;
    }
  }, [sidebarWidth, isCollapsed]);

  // Update sidebar width when collapsed state changes
  useEffect(() => {
    if (isCollapsed) {
      setSidebarWidth(COLLAPSED_WIDTH);
    } else {
      setSidebarWidth(lastExpandedWidthRef.current);
    }
  }, [isCollapsed]);

  // Save width to localStorage
  const saveWidth = React.useCallback(
    (width: number) => {
      localStorage.setItem(storageKey, width.toString());
    },
    [storageKey]
  );

  // Handle mouse down on resizer
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  // Handle mouse move and mouse up
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!sidebarRef.current) return;

      // Calculate width based on mouse position relative to sidebar's left edge
      const sidebarLeft = sidebarRef.current.getBoundingClientRect().left;
      const newWidth = e.clientX - sidebarLeft;

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setSidebarWidth(newWidth);
        // Auto-expand if dragged beyond threshold
        if (newWidth > AUTO_COLLAPSE_THRESHOLD && isCollapsed && onToggleCollapsed) {
          onToggleCollapsed();
        }
      } else if (newWidth <= AUTO_COLLAPSE_THRESHOLD && !isCollapsed && onToggleCollapsed) {
        // Auto-collapse if dragged below threshold
        onToggleCollapsed();
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      saveWidth(widthRef.current);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    // Prevent text selection while resizing
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing, minWidth, maxWidth, saveWidth, isCollapsed, onToggleCollapsed]);

  return (
    <div
      className={`hidden lg:flex relative ${isInitialized ? 'transition-all duration-300 ease-out' : ''}`}
      style={{
        width: `${sidebarWidth + SIDEBAR_MARGIN_X}px`,
        paddingTop: `${SIDEBAR_MARGIN_Y}px`,
        paddingBottom: `${SIDEBAR_MARGIN_Y}px`,
        paddingLeft: `${SIDEBAR_MARGIN_X}px`,
        paddingRight: 0,
      }}
    >
      {/* Glass morphism sidebar container */}
      <div
        className={`glass-sidebar ${isCollapsed ? 'collapsed' : ''}`}
        style={{ width: `${sidebarWidth}px` }}
      >
        {/* Sidebar content container */}
        <div ref={sidebarRef} className="glass-sidebar-content">
          {children}
        </div>

        {/* Resizer handle - disabled when collapsed */}
        {!isCollapsed && <div className="glass-sidebar-resizer" onMouseDown={handleMouseDown} />}
      </div>

      {/* Overlay while resizing to prevent interference */}
      {isResizing && (
        <div
          className="fixed inset-0 z-50"
          style={{
            cursor: 'col-resize',
            userSelect: 'none',
          }}
        />
      )}
    </div>
  );
}
