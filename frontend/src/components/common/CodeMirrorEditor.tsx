// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { EditorView, keymap, ViewUpdate } from '@codemirror/view'
import { EditorState, Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'
import { vim, Vim, getCM } from '@replit/codemirror-vim'
import { cn } from '@/lib/utils'
import type { ThemeMode } from '@/features/theme/ThemeProvider'

/**
 * Vim mode status indicator type
 */
export type VimMode = 'normal' | 'insert' | 'visual' | 'replace'

interface CodeMirrorEditorProps {
  /** The content to display/edit */
  value: string
  /** Callback when content changes */
  onChange?: (value: string) => void
  /** Callback for :w (save) command */
  onSave?: () => void
  /** Callback for :q (close) command */
  onClose?: () => void
  /** Current theme mode */
  theme?: ThemeMode
  /** Whether to enable Vim mode */
  vimEnabled?: boolean
  /** Whether the editor is read-only */
  readOnly?: boolean
  /** Additional className for the container */
  className?: string
  /** Placeholder text when empty */
  placeholder?: string
  /** Callback when Vim mode changes */
  onVimModeChange?: (mode: VimMode) => void
}

/**
 * Light theme for CodeMirror that matches the project's design system
 */
const lightTheme = EditorView.theme({
  '&': {
    backgroundColor: 'rgb(var(--color-bg-base))',
    color: 'rgb(var(--color-text-primary))',
  },
  '.cm-content': {
    caretColor: 'rgb(var(--color-primary))',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '14px',
    lineHeight: '1.6',
    padding: '16px',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'rgb(var(--color-primary))',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: 'rgb(var(--color-primary))',
  },
  '.cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(var(--color-primary), 0.2)',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(var(--color-primary), 0.3)',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(var(--color-primary), 0.05)',
  },
  '.cm-gutters': {
    backgroundColor: 'rgb(var(--color-bg-surface))',
    color: 'rgb(var(--color-text-muted))',
    border: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(var(--color-primary), 0.1)',
  },
  // Vim mode styling
  '.cm-fat-cursor': {
    backgroundColor: 'rgba(var(--color-primary), 0.7) !important',
    color: 'white !important',
  },
  '.cm-fat-cursor .cm-cursor-primary': {
    backgroundColor: 'rgba(var(--color-primary), 0.7)',
  },
  // Vim status panel
  '.cm-vim-panel': {
    backgroundColor: 'rgb(var(--color-bg-surface))',
    color: 'rgb(var(--color-text-primary))',
    padding: '4px 8px',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '12px',
  },
  '.cm-vim-panel input': {
    backgroundColor: 'transparent',
    color: 'rgb(var(--color-text-primary))',
    border: 'none',
    outline: 'none',
    fontFamily: 'inherit',
    fontSize: 'inherit',
  },
})

/**
 * Dark theme adjustments for CodeMirror
 */
const darkThemeOverrides = EditorView.theme(
  {
    '&': {
      backgroundColor: '#1e1e1e',
    },
    '.cm-content': {
      caretColor: '#14B8A6',
    },
    '.cm-gutters': {
      backgroundColor: '#252525',
      color: '#666',
    },
    '.cm-vim-panel': {
      backgroundColor: '#252525',
      color: '#e0e0e0',
    },
  },
  { dark: true }
)

/**
 * CodeMirror 6 based editor with Vim mode support
 *
 * Features:
 * - Full Vim emulation via @replit/codemirror-vim
 * - Light/dark theme support
 * - Ex commands (:w, :q, :wq) with callbacks
 * - Markdown syntax highlighting
 *
 * @example
 * ```tsx
 * <CodeMirrorEditor
 *   value={content}
 *   onChange={setContent}
 *   vimEnabled={true}
 *   theme="light"
 *   onSave={() => console.log('Saved!')}
 *   onClose={() => console.log('Closed!')}
 * />
 * ```
 */
export function CodeMirrorEditor({
  value,
  onChange,
  onSave,
  onClose,
  theme = 'light',
  vimEnabled = true,
  readOnly = false,
  className,
  placeholder,
  onVimModeChange,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<EditorView | null>(null)
  const [currentVimMode, setCurrentVimMode] = useState<VimMode>('normal')

  // Use refs to avoid stale closures in callbacks
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onCloseRef = useRef(onClose)
  const onVimModeChangeRef = useRef(onVimModeChange)
  const currentVimModeRef = useRef(currentVimMode)

  // Keep refs up to date
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    onVimModeChangeRef.current = onVimModeChange
  }, [onVimModeChange])

  useEffect(() => {
    currentVimModeRef.current = currentVimMode
  }, [currentVimMode])

  // Handle document changes
  const handleChange = useCallback((update: ViewUpdate) => {
    if (update.docChanged && onChangeRef.current) {
      onChangeRef.current(update.state.doc.toString())
    }
  }, [])

  // Configure Ex commands
  useEffect(() => {
    if (!vimEnabled) return

    // :w - Save
    Vim.defineEx('w', 'write', () => {
      onSaveRef.current?.()
    })

    // :q - Close/quit
    Vim.defineEx('q', 'quit', () => {
      onCloseRef.current?.()
    })

    // :wq - Save and close
    Vim.defineEx('wq', 'writequit', () => {
      onSaveRef.current?.()
      // Small delay to ensure save completes before close
      setTimeout(() => {
        onCloseRef.current?.()
      }, 100)
    })

    // :x - Same as :wq
    Vim.defineEx('x', 'exit', () => {
      onSaveRef.current?.()
      setTimeout(() => {
        onCloseRef.current?.()
      }, 100)
    })
  }, [vimEnabled])

  // Initialize editor
  useEffect(() => {
    if (!containerRef.current) return

    // Build extensions
    const extensions: Extension[] = [
      // Basic editing
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      // Markdown support
      markdown(),
      // Change listener
      EditorView.updateListener.of(handleChange),
      // Theme
      theme === 'dark' ? [oneDark, darkThemeOverrides] : lightTheme,
      // Basic settings
      EditorView.lineWrapping,
    ]

    // Add Vim mode if enabled
    if (vimEnabled) {
      extensions.unshift(vim())
    }

    // Add read-only if needed
    if (readOnly) {
      extensions.push(EditorState.readOnly.of(true))
    }

    // Create editor state
    const state = EditorState.create({
      doc: value,
      extensions,
    })

    // Create editor view
    const view = new EditorView({
      state,
      parent: containerRef.current,
    })

    editorRef.current = view

    // Set up vim mode change listener using the public getCM API
    let modeChangeHandler: ((modeObj: { mode: string; subMode?: string }) => void) | null = null
    if (vimEnabled) {
      const cm = getCM(view)
      if (cm) {
        modeChangeHandler = (modeObj: { mode: string; subMode?: string }) => {
          const mode = modeObj.mode as VimMode
          if (mode && mode !== currentVimModeRef.current) {
            setCurrentVimMode(mode)
            onVimModeChangeRef.current?.(mode)
          }
        }
        cm.on('vim-mode-change', modeChangeHandler)
      }
    }

    return () => {
      // Clean up vim mode change listener
      if (vimEnabled && modeChangeHandler) {
        const cm = getCM(view)
        if (cm) {
          cm.off('vim-mode-change', modeChangeHandler)
        }
      }
      view.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vimEnabled, theme, readOnly, handleChange])

  // Update content when value prop changes
  useEffect(() => {
    const view = editorRef.current
    if (!view) return

    const currentValue = view.state.doc.toString()
    if (value !== currentValue) {
      view.dispatch({
        changes: {
          from: 0,
          to: currentValue.length,
          insert: value,
        },
      })
    }
  }, [value])

  return (
    <div
      ref={containerRef}
      className={cn(
        'codemirror-editor',
        'flex-1 overflow-hidden',
        '[&_.cm-editor]:h-full [&_.cm-editor]:outline-none',
        '[&_.cm-scroller]:overflow-auto',
        className
      )}
      data-placeholder={placeholder}
    />
  )
}

/**
 * Vim mode indicator component
 * Displays the current Vim mode (NORMAL/INSERT/VISUAL/REPLACE)
 */
interface VimModeIndicatorProps {
  mode: VimMode
  className?: string
}

export function VimModeIndicator({ mode, className }: VimModeIndicatorProps) {
  const modeConfig = {
    normal: {
      label: 'NORMAL',
      bgColor: 'bg-blue-500/10',
      textColor: 'text-blue-600 dark:text-blue-400',
    },
    insert: {
      label: 'INSERT',
      bgColor: 'bg-green-500/10',
      textColor: 'text-green-600 dark:text-green-400',
    },
    visual: {
      label: 'VISUAL',
      bgColor: 'bg-purple-500/10',
      textColor: 'text-purple-600 dark:text-purple-400',
    },
    replace: {
      label: 'REPLACE',
      bgColor: 'bg-red-500/10',
      textColor: 'text-red-600 dark:text-red-400',
    },
  }

  const config = modeConfig[mode] || modeConfig.normal

  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium',
        config.bgColor,
        config.textColor,
        className
      )}
    >
      -- {config.label} --
    </span>
  )
}
