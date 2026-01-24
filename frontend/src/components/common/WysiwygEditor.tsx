// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Eye, Edit3, Columns, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import EnhancedMarkdown from './EnhancedMarkdown'
import { useTheme } from '@/features/theme/ThemeProvider'
import { CodeMirrorEditor, VimModeIndicator, VimMode } from './CodeMirrorEditor'
import { useTranslation } from '@/hooks/useTranslation'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from 'sonner'

const VIM_MODE_STORAGE_KEY = 'editor-vim-mode'

interface WysiwygEditorProps {
  initialContent: string
  onChange?: (content: string) => void
  onSave?: (content: string) => void
  onClose?: () => void
  className?: string
  readOnly?: boolean
  defaultVimMode?: boolean
}

type ViewMode = 'edit' | 'preview' | 'split'

/**
 * Markdown Editor component with Enhanced Markdown preview and Vim mode support
 *
 * Features:
 * - Real-time Markdown editing with live preview
 * - Three view modes: Edit only, Preview only, Split view
 * - CommonMark and GFM (GitHub Flavored Markdown) support via EnhancedMarkdown
 * - Syntax highlighting, Mermaid diagrams, and LaTeX math support in preview
 * - Vim mode with full keybinding support (via CodeMirror 6 + @replit/codemirror-vim)
 * - Content change callback
 *
 * @example
 * ```tsx
 * <WysiwygEditor
 *   initialContent="# Hello World"
 *   onChange={(markdown) => console.log(markdown)}
 *   onClose={() => console.log('Editor closed')}
 * />
 * ```
 */
export function WysiwygEditor({
  initialContent,
  onChange,
  onSave: _onSave,
  onClose,
  className,
  readOnly = false,
  defaultVimMode,
}: WysiwygEditorProps) {
  const [content, setContent] = useState(initialContent)
  const [viewMode, setViewMode] = useState<ViewMode>(readOnly ? 'preview' : 'split')
  const [vimEnabled, setVimEnabled] = useState<boolean>(() => {
    // Initialize from localStorage first, then prop, then default to false
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(VIM_MODE_STORAGE_KEY)
      if (stored !== null) return stored === 'true'
    }
    if (typeof defaultVimMode === 'boolean') return defaultVimMode
    return false
  })
  const [vimMode, setVimMode] = useState<VimMode>('normal')
  const [hasShownVimHint, setHasShownVimHint] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('editor-vim-hint-shown') === 'true'
    }
    return false
  })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { theme } = useTheme()
  const { t } = useTranslation('common')

  // Update content when initialContent changes (e.g., when switching documents)
  useEffect(() => {
    setContent(initialContent)
  }, [initialContent])

  // Persist vim mode preference
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(VIM_MODE_STORAGE_KEY, String(vimEnabled))
    }
  }, [vimEnabled])

  // Handle vim mode toggle
  const handleVimToggle = useCallback(() => {
    const newValue = !vimEnabled
    setVimEnabled(newValue)

    // Show hint toast on first enable
    if (newValue && !hasShownVimHint) {
      toast.info(t('editor.vim.hint_toast'), {
        description: t('editor.vim.hint_description'),
        duration: 5000,
      })
      setHasShownVimHint(true)
      if (typeof window !== 'undefined') {
        localStorage.setItem('editor-vim-hint-shown', 'true')
      }
    }
  }, [vimEnabled, hasShownVimHint, t])

  // Handle content change from textarea
  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newContent = e.target.value
      setContent(newContent)
      onChange?.(newContent)
    },
    [onChange]
  )

  // Handle content change from CodeMirror
  const handleCodeMirrorChange = useCallback(
    (newContent: string) => {
      setContent(newContent)
      onChange?.(newContent)
    },
    [onChange]
  )

  // Handle save from Vim :w command
  // Only shows toast notification, does not trigger actual save to backend
  // The actual save should be done via the Save button or :wq command
  const handleVimSave = useCallback(() => {
    // Sync content to parent via onChange (in-memory update only)
    onChange?.(content)
    toast.success(t('editor.vim.saved'))
  }, [content, onChange, t])

  // Handle close from Vim :q command
  const handleVimClose = useCallback(() => {
    onClose?.()
  }, [onClose])

  // Handle keyboard shortcuts for textarea
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
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-text-secondary">Markdown</span>
        {vimEnabled && viewMode !== 'preview' && <VimModeIndicator mode={vimMode} />}
      </div>
      {!readOnly && (
        <div className="flex items-center gap-1">
          {/* Vim mode toggle */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={vimEnabled ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={handleVimToggle}
                  className={cn(
                    'h-7 px-2',
                    vimEnabled && 'bg-primary/10 text-primary hover:bg-primary/20'
                  )}
                  title={t('editor.vim.toggle')}
                >
                  <Terminal className="w-3.5 h-3.5" />
                  <span className="ml-1 text-xs font-mono">Vim</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{vimEnabled ? t('editor.vim.disable') : t('editor.vim.enable')}</p>
                {vimEnabled && (
                  <p className="text-xs text-text-muted mt-1">{t('editor.vim.commands_hint')}</p>
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <div className="w-px h-4 bg-border mx-1" />

          {/* View mode buttons */}
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

  // Render the editor (textarea or CodeMirror based on vim mode)
  const renderEditor = () => (
    <div className={cn('flex flex-col', viewMode === 'split' ? 'w-1/2' : 'w-full')}>
      {viewMode === 'split' && (
        <div className="px-3 py-1.5 border-b border-border bg-surface text-xs font-medium text-text-secondary">
          Edit
        </div>
      )}
      {vimEnabled ? (
        <CodeMirrorEditor
          value={content}
          onChange={handleCodeMirrorChange}
          onSave={handleVimSave}
          onClose={handleVimClose}
          theme={theme}
          vimEnabled={true}
          readOnly={readOnly}
          onVimModeChange={setVimMode}
          className="flex-1"
          placeholder="Enter markdown content..."
        />
      ) : (
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          className={cn(
            'flex-1 w-full p-4 resize-none outline-none',
            'font-mono text-sm leading-relaxed',
            'text-text-primary bg-white dark:bg-gray-900',
            'placeholder:text-text-muted',
            readOnly && 'cursor-default'
          )}
          placeholder="Enter markdown content..."
          readOnly={readOnly}
          spellCheck={false}
        />
      )}
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
        <div className="flex-1 p-4 overflow-y-auto bg-white dark:bg-gray-900">
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
        'rounded-lg border border-border bg-white dark:bg-gray-900 overflow-hidden',
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
