// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, PanelRightClose, PanelRightOpen, Plus, FileText, Shield } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { DocumentList } from './DocumentList'
import { PermissionManagementTab } from '@/features/knowledge/permission/components/PermissionManagementTab'
import type { KnowledgeBase } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

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
  canManage?: boolean
  /** Whether the user can manage permissions (is creator or has manage permission) */
  canManagePermissions?: boolean
  /** Callback when document selection changes */
  onDocumentSelectionChange?: (documentIds: number[]) => void
  /** Callback when new chat button is clicked */
  onNewChat?: () => void
  /** Callback when knowledge base type is converted */
  onTypeConverted?: (updatedKb: KnowledgeBase) => void
  /** Callback when collapsed state changes */
  onCollapsedChange?: (collapsed: boolean) => void
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
  canManage = true,
  canManagePermissions = false,
  onDocumentSelectionChange,
  onNewChat,
  onTypeConverted,
  onCollapsedChange,
}: DocumentPanelProps) {
  const { t } = useTranslation('knowledge')

  // Tab state
  const [activeTab, setActiveTab] = useState<'documents' | 'permissions'>('documents')

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

  const router = useRouter()

  // Handle back to knowledge list
  const handleBack = () => {
    router.back()
  }

  // When collapsed, show a floating button to expand
  if (isCollapsed) {
    return (
      <div className="fixed top-2 sm:top-3 right-4 z-50">
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-3xl border border-border bg-base shadow-[0px_6px_8px_0px_rgba(51,51,51,0.06)] relative">
          <TooltipProvider>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <button
                  onClick={toggleCollapsed}
                  className="flex-shrink-0 p-1.5 -m-1.5 rounded-full hover:bg-hover transition-colors"
                  aria-label={t('chatPage.showDocuments')}
                >
                  <PanelRightOpen className="h-4 w-4 text-text-primary" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{t('chatPage.showDocuments')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={panelRef}
      className={`hidden lg:flex relative flex-col h-full border-l border-border bg-base ${isInitialized ? 'transition-all duration-200' : ''}`}
      style={{ width: `${panelWidth}px` }}
    >
      {/* Resizer handle - on the left edge */}
      <div
        className="absolute top-0 left-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/30 transition-colors group z-10"
        onMouseDown={handleMouseDown}
      >
        <div className="absolute inset-y-0 -left-1 -right-1 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>

      {/* Panel Header with Back Button and New Chat Button */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          {/* Back button */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBack}
            className="h-8 px-2 gap-1"
            title={t('chatPage.backToList')}
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="text-sm">{t('chatPage.backToList')}</span>
          </Button>
        </div>
        <div className="flex items-center gap-1">
          {/* New Note button */}
          {onNewChat && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onNewChat}
              className="h-8 px-2 gap-1"
              title={t('chatPage.newNote')}
            >
              <Plus className="w-4 h-4" />
              <span className="text-sm">{t('chatPage.newNote')}</span>
            </Button>
          )}
          {/* Collapse button */}
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleCollapsed}
            className="h-8 w-8 p-0"
            title={t('chatPage.hideDocuments')}
          >
            <PanelRightClose className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Content area with tabs */}
      {canManagePermissions ? (
        <Tabs
          value={activeTab}
          onValueChange={value => setActiveTab(value as 'documents' | 'permissions')}
          className="flex-1 flex flex-col overflow-hidden"
        >
          <TabsList className="mx-4 mt-3 grid w-auto grid-cols-2">
            <TabsTrigger value="documents" className="gap-1.5">
              <FileText className="w-4 h-4" />
              {t('chatPage.documents')}
            </TabsTrigger>
            <TabsTrigger value="permissions" className="gap-1.5">
              <Shield className="w-4 h-4" />
              {t('document.permission.management')}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="documents" className="flex-1 overflow-auto p-4 mt-0">
            <DocumentList
              knowledgeBase={knowledgeBase}
              canManage={canManage}
              compact={true}
              onSelectionChange={onDocumentSelectionChange}
              onTypeConverted={onTypeConverted}
            />
          </TabsContent>
          <TabsContent value="permissions" className="flex-1 overflow-auto mt-0">
            <PermissionManagementTab kbId={knowledgeBase.id} />
          </TabsContent>
        </Tabs>
      ) : (
        /* Document List only - no permission management */
        <div className="flex-1 overflow-auto p-4">
          <DocumentList
            knowledgeBase={knowledgeBase}
            canManage={canManage}
            compact={true}
            onSelectionChange={onDocumentSelectionChange}
            onTypeConverted={onTypeConverted}
          />
        </div>
      )}

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
