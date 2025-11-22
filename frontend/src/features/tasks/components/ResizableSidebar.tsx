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
}

export default function ResizableSidebar({
  children,
  minWidth = 200,
  maxWidth = 500,
  defaultWidth = 224, // 56 * 4 = 224px (w-56 equivalent)
  storageKey = 'task-sidebar-width',
}: ResizableSidebarProps) {
  const [sidebarWidth, setSidebarWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(defaultWidth);

  // Keep widthRef in sync with sidebarWidth
  useEffect(() => {
    widthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  // Load saved width from localStorage
  useEffect(() => {
    const savedWidth = localStorage.getItem(storageKey);
    if (savedWidth) {
      const width = parseInt(savedWidth, 10);
      if (width >= minWidth && width <= maxWidth) {
        setSidebarWidth(width);
      }
    }
  }, [storageKey, minWidth, maxWidth]);

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
  }, [isResizing, minWidth, maxWidth, saveWidth]);

  return (
    <div
      className="hidden lg:flex relative"
      style={{ width: `${sidebarWidth}px` }}
    >
      {/* Sidebar content container */}
      <div ref={sidebarRef} className="flex flex-col w-full h-full">
        {children}
      </div>

      {/* Resizer handle */}
      <div
        className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/30 transition-colors group"
        onMouseDown={handleMouseDown}
        style={{
          zIndex: 10,
        }}
      >
        {/* Visual indicator on hover */}
        <div className="absolute inset-y-0 -left-1 -right-1 opacity-0 group-hover:opacity-100 transition-opacity" />
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
