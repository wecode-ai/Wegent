// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { history } from '@milkdown/plugin-history'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { getMarkdown } from '@milkdown/utils'
import { cn } from '@/lib/utils'

interface WysiwygEditorProps {
  initialContent: string
  onChange?: (content: string) => void
  className?: string
  readOnly?: boolean
}

/**
 * Internal Milkdown editor component
 */
function MilkdownEditor({
  initialContent,
  onChange,
  readOnly = false,
}: Omit<WysiwygEditorProps, 'className'>) {
  const editorRef = useRef<Editor | null>(null)

  const { get } = useEditor(
    (root) => {
      const editor = Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root)
          ctx.set(defaultValueCtx, initialContent)

          // Setup listener for content changes
          const listenerInstance = ctx.get(listenerCtx)
          listenerInstance.markdownUpdated((_, markdown) => {
            if (onChange) {
              onChange(markdown)
            }
          })
        })
        .use(commonmark)
        .use(gfm)
        .use(listener)
        .use(history)

      return editor
    },
    [initialContent]
  )

  // Store editor reference
  useEffect(() => {
    const editor = get()
    if (editor) {
      editorRef.current = editor
    }
  }, [get])

  // Handle read-only mode
  useEffect(() => {
    const editor = get()
    if (editor) {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        if (view) {
          view.setProps({
            editable: () => !readOnly,
          })
        }
      })
    }
  }, [get, readOnly])

  return <Milkdown />
}

/**
 * WYSIWYG Markdown Editor component using Milkdown
 *
 * Features:
 * - Real-time Markdown editing with WYSIWYG preview
 * - CommonMark and GFM (GitHub Flavored Markdown) support
 * - History (undo/redo) support
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
  return (
    <div
      className={cn(
        'wysiwyg-editor prose prose-sm max-w-none',
        // Base styling
        'min-h-[300px] w-full',
        // Border and background
        'rounded-lg border border-border bg-surface',
        // Focus styling
        'focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary',
        // Padding for content area
        '[&_.milkdown]:p-4',
        // Typography styling for editor content
        '[&_.milkdown]:text-text-primary [&_.milkdown]:text-sm [&_.milkdown]:leading-relaxed',
        // Heading styles
        '[&_.milkdown_h1]:text-xl [&_.milkdown_h1]:font-bold [&_.milkdown_h1]:mt-6 [&_.milkdown_h1]:mb-4',
        '[&_.milkdown_h2]:text-lg [&_.milkdown_h2]:font-semibold [&_.milkdown_h2]:mt-5 [&_.milkdown_h2]:mb-3',
        '[&_.milkdown_h3]:text-base [&_.milkdown_h3]:font-semibold [&_.milkdown_h3]:mt-4 [&_.milkdown_h3]:mb-2',
        // Paragraph styles
        '[&_.milkdown_p]:my-2',
        // List styles
        '[&_.milkdown_ul]:list-disc [&_.milkdown_ul]:pl-6 [&_.milkdown_ul]:my-2',
        '[&_.milkdown_ol]:list-decimal [&_.milkdown_ol]:pl-6 [&_.milkdown_ol]:my-2',
        '[&_.milkdown_li]:my-1',
        // Code styles
        '[&_.milkdown_code]:bg-muted [&_.milkdown_code]:px-1.5 [&_.milkdown_code]:py-0.5 [&_.milkdown_code]:rounded [&_.milkdown_code]:text-xs [&_.milkdown_code]:font-mono',
        '[&_.milkdown_pre]:bg-muted [&_.milkdown_pre]:p-3 [&_.milkdown_pre]:rounded-lg [&_.milkdown_pre]:overflow-x-auto [&_.milkdown_pre]:my-3',
        // Blockquote styles
        '[&_.milkdown_blockquote]:border-l-4 [&_.milkdown_blockquote]:border-primary/50 [&_.milkdown_blockquote]:pl-4 [&_.milkdown_blockquote]:my-3 [&_.milkdown_blockquote]:text-text-secondary [&_.milkdown_blockquote]:italic',
        // Link styles
        '[&_.milkdown_a]:text-primary [&_.milkdown_a]:underline [&_.milkdown_a]:underline-offset-2',
        // Table styles
        '[&_.milkdown_table]:w-full [&_.milkdown_table]:border-collapse [&_.milkdown_table]:my-3',
        '[&_.milkdown_th]:border [&_.milkdown_th]:border-border [&_.milkdown_th]:px-3 [&_.milkdown_th]:py-2 [&_.milkdown_th]:bg-muted [&_.milkdown_th]:font-medium',
        '[&_.milkdown_td]:border [&_.milkdown_td]:border-border [&_.milkdown_td]:px-3 [&_.milkdown_td]:py-2',
        // HR style
        '[&_.milkdown_hr]:my-4 [&_.milkdown_hr]:border-border',
        // Strong and emphasis
        '[&_.milkdown_strong]:font-bold',
        '[&_.milkdown_em]:italic',
        // Strikethrough
        '[&_.milkdown_del]:line-through',
        // Read-only mode cursor
        readOnly && 'cursor-default [&_.milkdown]:cursor-default',
        className
      )}
    >
      <MilkdownProvider>
        <MilkdownEditor
          initialContent={initialContent}
          onChange={onChange}
          readOnly={readOnly}
        />
      </MilkdownProvider>
    </div>
  )
}

/**
 * Fallback Markdown Editor using @uiw/react-md-editor
 *
 * Used when Milkdown has compatibility issues.
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
    import('@uiw/react-md-editor').then((mod) => {
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
