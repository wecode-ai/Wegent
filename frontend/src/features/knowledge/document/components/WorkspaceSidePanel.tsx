// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface WorkspaceSidePanelProps {
  side: 'left' | 'right'
  storageKey: string
  defaultWidth: number
  minWidth: number
  maxWidth: number
  collapsedWidth?: number
  mobileVisible: boolean
  expandLabel: string
  collapseLabel: string
  resizeLabel: string
  expandTestId: string
  collapseTestId: string
  children: ReactNode | ((state: { isDesktopCollapsed: boolean }) => ReactNode)
}

function readStoredWidth(storageKey: string, fallback: number, min: number, max: number) {
  if (typeof window === 'undefined') return fallback
  try {
    const saved = Number(localStorage.getItem(`${storageKey}-width`))
    return Number.isFinite(saved) && saved >= min && saved <= max ? saved : fallback
  } catch {
    return fallback
  }
}

function readStoredCollapsed(storageKey: string) {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(`${storageKey}-collapsed`) === 'true'
  } catch {
    return false
  }
}

function writeStoredValue(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage may be unavailable in private browsing mode.
  }
}

export function WorkspaceSidePanel({
  side,
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  collapsedWidth = 0,
  mobileVisible,
  expandLabel,
  collapseLabel,
  resizeLabel,
  expandTestId,
  collapseTestId,
  children,
}: WorkspaceSidePanelProps) {
  const [width, setWidth] = useState(() =>
    readStoredWidth(storageKey, defaultWidth, minWidth, maxWidth)
  )
  const [isCollapsed, setIsCollapsed] = useState(() => readStoredCollapsed(storageKey))
  const [isResizing, setIsResizing] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(width)

  useEffect(() => {
    widthRef.current = width
  }, [width])

  const toggleCollapsed = useCallback(() => {
    setIsCollapsed(current => {
      const next = !current
      writeStoredValue(`${storageKey}-collapsed`, String(next))
      return next
    })
  }, [storageKey])

  const handlePointerDown = (event: ReactPointerEvent) => {
    event.preventDefault()
    setIsResizing(true)
  }

  const handleResizeKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const horizontalDirection = event.key === 'ArrowRight' ? 1 : -1
    const panelDirection = side === 'left' ? horizontalDirection : -horizontalDirection
    setWidth(current => {
      const next = Math.min(maxWidth, Math.max(minWidth, current + panelDirection * 20))
      writeStoredValue(`${storageKey}-width`, String(next))
      return next
    })
  }

  useEffect(() => {
    if (!isResizing) return

    const handlePointerMove = (event: PointerEvent) => {
      const bounds = panelRef.current?.getBoundingClientRect()
      if (!bounds) return
      const nextWidth = side === 'left' ? event.clientX - bounds.left : bounds.right - event.clientX
      if (nextWidth >= minWidth && nextWidth <= maxWidth) {
        setWidth(nextWidth)
      }
    }

    const handlePointerUp = () => {
      setIsResizing(false)
      writeStoredValue(`${storageKey}-width`, String(widthRef.current))
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)
    document.addEventListener('pointercancel', handlePointerUp)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
      document.removeEventListener('pointercancel', handlePointerUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [isResizing, maxWidth, minWidth, side, storageKey])

  const ExpandIcon = side === 'left' ? PanelLeftOpen : PanelRightOpen
  const CollapseIcon = side === 'left' ? PanelLeftClose : PanelRightClose
  const collapsedOnDesktop = isCollapsed && !mobileVisible
  const hasCollapsedRail = collapsedWidth > 0
  const content =
    typeof children === 'function' ? children({ isDesktopCollapsed: collapsedOnDesktop }) : children

  return (
    <div
      ref={panelRef}
      className={`${mobileVisible ? 'flex' : 'hidden'} relative h-full shrink-0 flex-col bg-base max-lg:!w-full lg:flex ${
        collapsedOnDesktop && !hasCollapsedRail
          ? ''
          : side === 'left'
            ? 'border-r border-border'
            : 'border-l border-border'
      }`}
      style={{ width: collapsedOnDesktop ? collapsedWidth : width }}
    >
      {collapsedOnDesktop && (
        <TooltipProvider>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant={hasCollapsedRail ? 'ghost' : 'outline'}
                size="sm"
                onClick={toggleCollapsed}
                className={`absolute z-30 h-8 w-8 bg-base p-0 ${
                  hasCollapsedRail
                    ? 'left-1/2 top-3 -translate-x-1/2 rounded-md'
                    : `top-4 rounded-full shadow-md ${side === 'left' ? 'left-3' : 'right-3'}`
                }`}
                aria-label={expandLabel}
                data-testid={expandTestId}
              >
                <ExpandIcon className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side={side === 'left' ? 'right' : 'left'}>{expandLabel}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <div
        className={`absolute inset-y-0 z-20 hidden w-1 touch-none cursor-col-resize transition-colors hover:bg-primary/30 focus:bg-primary/30 focus:outline-none ${
          collapsedOnDesktop ? '' : 'lg:block'
        } ${side === 'left' ? 'right-0' : 'left-0'}`}
        role="separator"
        aria-label={resizeLabel}
        aria-orientation="vertical"
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={collapsedOnDesktop ? -1 : 0}
        onPointerDown={handlePointerDown}
        onKeyDown={handleResizeKeyDown}
      />
      {!collapsedOnDesktop && (
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleCollapsed}
          className="absolute right-3 top-3 z-10 hidden h-8 w-8 p-0 lg:inline-flex"
          title={collapseLabel}
          aria-label={collapseLabel}
          data-testid={collapseTestId}
        >
          <CollapseIcon className="h-4 w-4" />
        </Button>
      )}
      <div
        className={`${
          collapsedOnDesktop && !hasCollapsedRail ? 'hidden' : 'flex'
        } min-h-0 flex-1 flex-col`}
      >
        {content}
      </div>
      {isResizing && <div className="fixed inset-0 z-50 cursor-col-resize select-none" />}
    </div>
  )
}
