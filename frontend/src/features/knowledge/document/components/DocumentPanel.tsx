// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Bot, Database, PanelRightClose, PanelRightOpen, Plus, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { KnowledgeBase } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ArtifactPanel } from '@/features/knowledge/artifact/components/ArtifactPanel'
import { ArtifactSourceDialog } from '@/features/knowledge/artifact/components/ArtifactSourceDialog'

// Helper function to get initial width from localStorage
const getInitialWidth = (
  storageKey: string,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number
): number => {
  if (typeof window === 'undefined') return defaultWidth
  try {
    const savedWidth = localStorage.getItem(storageKey)
    if (savedWidth) {
      const width = parseInt(savedWidth, 10)
      if (width >= minWidth && width <= maxWidth) {
        return width
      }
    }
  } catch {
    // localStorage may be unavailable in private browsing mode
  }
  return defaultWidth
}

// Helper function to get initial collapsed state from localStorage
const getInitialCollapsed = (storageKey: string, defaultCollapsed: boolean): boolean => {
  if (typeof window === 'undefined') return defaultCollapsed
  try {
    const saved = localStorage.getItem(storageKey)
    if (saved !== null) {
      return saved === 'true'
    }
  } catch {
    // localStorage may be unavailable in private browsing mode
  }
  return defaultCollapsed
}

interface DocumentPanelProps {
  knowledgeBase: KnowledgeBase
  /** Callback when document selection changes */
  onDocumentSelectionChange?: (documentIds: number[]) => void
  /** Current document selection used as Artifact source scope */
  selectedDocumentIds?: number[]
  /** Callback when new chat button is clicked */
  onNewChat?: () => void
  /** Callback when collapsed state changes */
  onCollapsedChange?: (collapsed: boolean) => void
  /** Whether the AI Workshop is the active workspace surface on small screens. */
  mobileVisible?: boolean
}

const MIN_WIDTH = 280
const MAX_WIDTH = 600
const DEFAULT_WIDTH = 420
const STORAGE_KEY_WIDTH = 'kb-document-panel-width'
const STORAGE_KEY_COLLAPSED = 'kb-document-panel-collapsed'

/**
 * Collapsible Document Panel Component
 *
 * A resizable right-side panel that displays the document list.
 * Features:
 * - Resizable width via drag handle
 * - Collapsible to save space
 * - Width and collapsed state persisted in localStorage
 */
export function DocumentPanel({
  knowledgeBase,
  onDocumentSelectionChange,
  selectedDocumentIds = [],
  onNewChat,
  onCollapsedChange,
  mobileVisible = false,
}: DocumentPanelProps) {
  const { t } = useTranslation('knowledge')
  const { t: tCommon } = useTranslation('common')

  const [sourceDialogOpen, setSourceDialogOpen] = useState(false)
  const [availableDocumentCount, setAvailableDocumentCount] = useState<number | null>(null)
  const sourceApplyContinuationRef = useRef<(() => void) | null>(null)

  // Initialize state with localStorage values
  const [panelWidth, setPanelWidth] = useState(() =>
    getInitialWidth(STORAGE_KEY_WIDTH, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH)
  )
  const [isCollapsed, setIsCollapsed] = useState(() =>
    getInitialCollapsed(STORAGE_KEY_COLLAPSED, false)
  )
  const [isResizing, setIsResizing] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(panelWidth)

  // Mark as initialized after first render
  useEffect(() => {
    setIsInitialized(true)
  }, [])

  // Notify parent when collapsed state changes
  useEffect(() => {
    onCollapsedChange?.(isCollapsed)
  }, [isCollapsed, onCollapsedChange])

  // Keep widthRef in sync
  useEffect(() => {
    widthRef.current = panelWidth
  }, [panelWidth])

  // Save width to localStorage
  const saveWidth = useCallback((width: number) => {
    try {
      localStorage.setItem(STORAGE_KEY_WIDTH, width.toString())
    } catch {
      // localStorage may be unavailable
    }
  }, [])

  // Save collapsed state to localStorage
  const saveCollapsed = useCallback((collapsed: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY_COLLAPSED, collapsed.toString())
    } catch {
      // localStorage may be unavailable
    }
  }, [])

  // Toggle collapsed state
  const toggleCollapsed = useCallback(() => {
    setIsCollapsed(prev => {
      const newValue = !prev
      saveCollapsed(newValue)
      return newValue
    })
  }, [saveCollapsed])

  const openSourceDialog = useCallback((onApplied?: () => void) => {
    sourceApplyContinuationRef.current = onApplied ?? null
    setSourceDialogOpen(true)
  }, [])

  const handleSourceDialogOpenChange = useCallback((open: boolean) => {
    setSourceDialogOpen(open)
    if (!open) {
      const continuation = sourceApplyContinuationRef.current
      sourceApplyContinuationRef.current = null
      continuation?.()
    }
  }, [])

  // Handle mouse down on resizer
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }

  // Handle mouse move and mouse up
  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!panelRef.current) return

      // Calculate width based on mouse position relative to panel's right edge
      const panelRight = panelRef.current.getBoundingClientRect().right
      const newWidth = panelRight - e.clientX

      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        setPanelWidth(newWidth)
      }
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      saveWidth(widthRef.current)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [isResizing, saveWidth])

  // When collapsed, return null (the expand button is rendered as a portal-like fixed element)
  // This ensures the collapsed state doesn't affect the parent flex layout
  if (isCollapsed && !mobileVisible) {
    return (
      <>
        {/* Fixed expand button - positioned outside the flex flow */}
        <div className="fixed top-16 right-4 z-40">
          <TooltipProvider>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={toggleCollapsed}
                  className="h-8 w-8 p-0 rounded-full shadow-md bg-base"
                  aria-label={t('artifact.showWorkshop')}
                >
                  <PanelRightOpen className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                <p>{t('artifact.showWorkshop')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </>
    )
  }

  return (
    <div
      ref={panelRef}
      className={`${mobileVisible ? 'flex' : 'hidden'} max-lg:!w-full lg:flex relative flex-col h-full border-l max-lg:border-l-0 border-border bg-base ${isInitialized ? 'transition-all duration-200' : ''}`}
      style={{ width: `${panelWidth}px` }}
    >
      {/* Resizer handle - on the left edge */}
      <div
        className="absolute top-0 left-0 bottom-0 hidden w-1 cursor-col-resize hover:bg-primary/30 transition-colors group z-10 lg:block"
        onMouseDown={handleMouseDown}
      >
        <div className="absolute inset-y-0 -left-1 -right-1 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-2 px-4 pt-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="rounded-xl bg-primary/10 p-2.5 text-primary">
              <Bot className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="font-semibold">{t('artifact.aiWorkshop')}</h2>
              <p className="mt-0.5 text-xs text-text-secondary">{t('artifact.aiWorkshopHint')}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {onNewChat && (
              <TooltipProvider>
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onNewChat}
                      className="h-8 w-8 p-0"
                      data-testid="new-chat-button"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p>{tCommon('tasks.new_conversation')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleCollapsed}
              className="hidden h-8 w-8 p-0 lg:inline-flex"
              title={t('artifact.hideWorkshop')}
              data-testid="knowledge-panel-collapse-button"
            >
              <PanelRightClose className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <button
          type="button"
          className="mx-4 mt-4 flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-3 text-left transition-colors hover:border-primary hover:bg-hover"
          onClick={() => openSourceDialog()}
          data-testid="artifact-source-summary"
        >
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <Database className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-text-muted">{t('artifact.source')}</p>
            <p className="truncate text-sm font-medium">
              {selectedDocumentIds.length > 0
                ? t('artifact.selectedDocuments', { count: selectedDocumentIds.length })
                : t('artifact.wholeKnowledgeBase', {
                    count: availableDocumentCount ?? knowledgeBase.document_count,
                  })}
            </p>
            <p className="mt-0.5 text-xs text-text-muted">{t('artifact.sourceUsageHint')}</p>
          </div>
          <Settings2 className="h-4 w-4 text-text-muted" />
        </button>

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          <ArtifactPanel
            knowledgeBaseId={knowledgeBase.id}
            selectedDocumentIds={selectedDocumentIds}
            onAdjustSources={openSourceDialog}
            onAvailableDocumentCountChange={setAvailableDocumentCount}
          />
        </div>
      </div>

      <ArtifactSourceDialog
        knowledgeBaseId={knowledgeBase.id}
        open={sourceDialogOpen}
        selectedDocumentIds={selectedDocumentIds}
        availableDocumentCount={availableDocumentCount}
        onOpenChange={handleSourceDialogOpenChange}
        onApply={documentIds => {
          const continuation = sourceApplyContinuationRef.current
          onDocumentSelectionChange?.(documentIds)
          sourceApplyContinuationRef.current = null
          continuation?.()
        }}
      />

      {/* Overlay while resizing */}
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
  )
}
