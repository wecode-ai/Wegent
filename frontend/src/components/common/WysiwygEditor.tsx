// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Eye, Edit3, Columns } from 'lucide-react'
import { Button } from '@/components/ui/button'
import EnhancedMarkdown from './EnhancedMarkdown'
import { useTheme } from '@/features/theme/ThemeProvider'

interface WysiwygEditorProps {
  initialContent: string
  onChange?: (content: string) => void
  className?: string
  readOnly?: boolean
}

type ViewMode = 'edit' | 'preview' | 'split'

/**
 * Markdown Editor component with Enhanced Markdown preview
 *
 * Features:
 * - Real-time Markdown editing with live preview
 * - Three view modes: Edit only, Preview only, Split view
 * - CommonMark and GFM (GitHub Flavored Markdown) support via EnhancedMarkdown
 * - Syntax highlighting, Mermaid diagrams, and LaTeX math support in preview
 * - Content change callback
 *
 * @example
 * ```tsx
 * <WysiwygEditor
 *   initialContent="# Hello World"
 *   onChange={(markdown) => console.log(markdown)}
 * />
 * ```
 */
export function WysiwygEditor({
  initialContent,
  onChange,
  className,
  readOnly = false,
}: WysiwygEditorProps) {
  const [content, setContent] = useState(initialContent)
  const [viewMode, setViewMode] = useState<ViewMode>(readOnly ? 'preview' : 'split')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { theme } = useTheme()

  // Update content when initialContent changes (e.g., when switching documents)
  useEffect(() => {
    setContent(initialContent)
  }, [initialContent])

  // Handle content change
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newContent = e.target.value
      setContent(newContent)
      onChange?.(newContent)
    },
    [onChange]
  )

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Tab key inserts spaces instead of changing focus
      if (e.key === 'Tab') {
        e.preventDefault()
        const textarea = textareaRef.current
        if (!textarea) return

        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const newContent = content.substring(0, start) + '  ' + content.substring(end)
        setContent(newContent)
        onChange?.(newContent)

        // Move cursor after the inserted spaces
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 2
        })
      }
    },
    [content, onChange]
  )

  // Render the editor toolbar
  const renderToolbar = () => (
    <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface-hover/50">
      <div className="flex items-center gap-1">
        <span className="text-xs font-medium text-text-secondary">Markdown</span>
      </div>
      {!readOnly && (
        <div className="flex items-center gap-1">
          <Button
            variant={viewMode === 'edit' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setViewMode('edit')}
            className="h-7 px-2"
            title="Edit mode"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant={viewMode === 'split' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setViewMode('split')}
            className="h-7 px-2"
            title="Split view"
          >
            <Columns className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant={viewMode === 'preview' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setViewMode('preview')}
            className="h-7 px-2"
            title="Preview mode"
          >
            <Eye className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}
    </div>
  )

  // Render the editor textarea
  const renderEditor = () => (
    <div className={cn('flex flex-col', viewMode === 'split' ? 'w-1/2' : 'w-full')}>
      {viewMode === 'split' && (
        <div className="px-3 py-1.5 border-b border-border bg-surface text-xs font-medium text-text-secondary">
          Edit
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        className={cn(
          'flex-1 w-full p-4 resize-none outline-none',
          'font-mono text-sm leading-relaxed',
          'text-text-primary bg-white',
          'placeholder:text-text-muted',
          readOnly && 'cursor-default'
        )}
        placeholder="Enter markdown content..."
        readOnly={readOnly}
        spellCheck={false}
      />
    </div>
  )

  // Render the preview panel - same as MessageBubble
  const renderPreview = () => {
    // Normalize content same as MessageBubble's renderMarkdownResult
    const trimmed = (content ?? '').trim()
    const fencedMatch = trimmed.match(/^```(?:\s*(?:markdown|md))?\s*\n([\s\S]*?)\n```$/)
    const normalizedResult = fencedMatch ? fencedMatch[1] : trimmed

    return (
      <div
        className={cn(
          'flex flex-col overflow-hidden',
          viewMode === 'split' ? 'w-1/2 border-l border-border' : 'w-full'
        )}
      >
        {viewMode === 'split' && (
          <div className="px-3 py-1.5 border-b border-border bg-surface text-xs font-medium text-text-secondary">
            Preview
          </div>
        )}
        <div className="flex-1 p-4 overflow-y-auto bg-white">
          {normalizedResult ? (
            <EnhancedMarkdown source={normalizedResult} theme={theme} />
          ) : (
            <p className="text-text-muted text-sm italic">No content to preview</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'wysiwyg-editor',
        // Base styling - flex to fill container
        'flex flex-col min-h-[300px] h-full w-full',
        // Border and background
        'rounded-lg border border-border bg-white overflow-hidden',
        // Focus styling
        'focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary',
        className
      )}
    >
      {/* Toolbar */}
      {renderToolbar()}

      {/* Content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Edit mode: show only editor */}
        {viewMode === 'edit' && renderEditor()}

        {/* Preview mode: show only preview */}
        {viewMode === 'preview' && renderPreview()}

        {/* Split mode: show both */}
        {viewMode === 'split' && (
          <>
            {renderEditor()}
            {renderPreview()}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Fallback Markdown Editor using @uiw/react-md-editor
 *
 * Used when the main editor has compatibility issues.
 * Provides a simpler split-pane or preview mode editing experience.
 */
export function MarkdownEditorFallback({
  initialContent,
  onChange,
  className,
  readOnly = false,
}: WysiwygEditorProps) {
  const [content, setContent] = useState(initialContent)

  const handleChange = useCallback(
    (value: string | undefined) => {
      const newContent = value || ''
      setContent(newContent)
      onChange?.(newContent)
    },
    [onChange]
  )

  // Dynamically import to avoid SSR issues
  const [MDEditor, setMDEditor] = useState<typeof import('@uiw/react-md-editor').default | null>(
    null
  )

  useEffect(() => {
    import('@uiw/react-md-editor').then(mod => {
      setMDEditor(() => mod.default)
    })
  }, [])

  if (!MDEditor) {
    return (
      <div className={cn('min-h-[300px] animate-pulse rounded-lg bg-surface', className)}>
        <div className="flex items-center justify-center h-full text-text-muted">Loading...</div>
      </div>
    )
  }

  return (
    <div className={cn('markdown-editor-fallback', className)} data-color-mode="light">
      <MDEditor
        value={content}
        onChange={handleChange}
        preview={readOnly ? 'preview' : 'live'}
        height={400}
        hideToolbar={readOnly}
        visibleDragbar={!readOnly}
      />
    </div>
  )
}
