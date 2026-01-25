// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useRef, useCallback, useState } from 'react'
import { EditorView } from '@codemirror/view'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { useAIAssist, AIAssistProvider } from './AIAssistContext'
import { FloatingToolbar } from './FloatingToolbar'
import { CommandPalette } from './CommandPalette'
import { InlineDiff } from './InlineDiff'
import { useCommandPalette } from './hooks/useCommandPalette'
import { useAIAssistAPI } from './hooks/useAIAssistAPI'
import type { EditorSelection } from './types'

interface AIAssistEditorWrapperProps {
  /** The CodeMirror EditorView instance */
  editorView: EditorView | null
  /** Knowledge base ID for search operations */
  knowledgeBaseId?: number
  /** Callback when content should be sent to chat */
  onSendToChat?: (content: string) => void
  /** Children (the actual editor) */
  children: React.ReactNode
  /** Additional class name */
  className?: string
}

/**
 * Internal component that uses the AI Assist context
 */
function AIAssistEditorInner({
  editorView,
  knowledgeBaseId,
  onSendToChat,
  children,
  className,
}: AIAssistEditorWrapperProps) {
  const { t } = useTranslation('knowledge')
  const { state, editorRef, setSelection } = useAIAssist()
  const { processRequest, cancelRequest: _cancelRequest } = useAIAssistAPI({ knowledgeBaseId })
  const containerRef = useRef<HTMLDivElement>(null)

  // Command palette state
  const {
    isOpen: isPaletteOpen,
    position: palettePosition,
    closePalette,
    shortcutDisplayText,
  } = useCommandPalette({
    containerRef,
  })

  // Track selection in the editor
  const [localSelection, setLocalSelection] = useState<EditorSelection | null>(null)

  // Set up editor ref functions
  useEffect(() => {
    if (!editorView) return

    editorRef.current = {
      getContent: () => editorView.state.doc.toString(),
      setContent: (content: string) => {
        editorView.dispatch({
          changes: {
            from: 0,
            to: editorView.state.doc.length,
            insert: content,
          },
        })
      },
      getSelection: () => {
        const { from, to } = editorView.state.selection.main
        if (from === to) return null

        const text = editorView.state.doc.sliceString(from, to)
        const coords = editorView.coordsAtPos(from)

        return {
          text,
          from,
          to,
          position: coords
            ? { top: coords.top, left: coords.left }
            : { top: 0, left: 0 },
        }
      },
      replaceSelection: (from: number, to: number, text: string) => {
        editorView.dispatch({
          changes: { from, to, insert: text },
        })
      },
      insertAtCursor: (text: string) => {
        const pos = editorView.state.selection.main.head
        editorView.dispatch({
          changes: { from: pos, to: pos, insert: text },
        })
      },
      focus: () => editorView.focus(),
      getCursorPosition: () => {
        const pos = editorView.state.selection.main.head
        const coords = editorView.coordsAtPos(pos)
        return coords ? pos : 0
      },
      getContext: (charsBefore: number, charsAfter: number) => {
        const pos = editorView.state.selection.main.head
        const doc = editorView.state.doc.toString()
        const before = doc.slice(Math.max(0, pos - charsBefore), pos)
        const after = doc.slice(pos, Math.min(doc.length, pos + charsAfter))
        return { before, after }
      },
    }
  }, [editorView, editorRef])

  // Monitor selection changes in editor
  useEffect(() => {
    if (!editorView) return

    // Note: EditorView.updateListener.of() creates an extension, not a direct listener
    // We use polling instead since we can't dynamically add extensions to an existing view
    const _updateListener = EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged) {
        const { from, to } = update.state.selection.main

        if (from !== to) {
          const text = update.state.doc.sliceString(from, to)
          const coords = editorView.coordsAtPos(from)

          if (text.trim().length > 0) {
            const selection: EditorSelection = {
              text,
              from,
              to,
              position: coords
                ? { top: coords.top, left: coords.left }
                : { top: 0, left: 0 },
            }
            setLocalSelection(selection)
            setSelection(selection)
          } else {
            setLocalSelection(null)
            setSelection(null)
          }
        } else {
          setLocalSelection(null)
          setSelection(null)
        }
      }
    })

    // Note: We can't directly add this listener to an existing view
    // The listener should be added during view creation
    // For now, we'll use a polling approach
    const interval = setInterval(() => {
      if (!editorView) return

      const { from, to } = editorView.state.selection.main

      if (from !== to) {
        const text = editorView.state.doc.sliceString(from, to)
        const coords = editorView.coordsAtPos(from)

        if (text.trim().length > 0) {
          const selection: EditorSelection = {
            text,
            from,
            to,
            position: coords
              ? { top: coords.top, left: coords.left }
              : { top: 0, left: 0 },
          }

          // Only update if selection changed
          if (
            !localSelection ||
            localSelection.from !== from ||
            localSelection.to !== to
          ) {
            setLocalSelection(selection)
            setSelection(selection)
          }
        }
      } else if (localSelection) {
        setLocalSelection(null)
        setSelection(null)
      }
    }, 200)

    return () => {
      clearInterval(interval)
    }
  }, [editorView, localSelection, setSelection])

  // Handle AI operation start
  useEffect(() => {
    if (
      state.status === 'thinking' &&
      state.lastAction &&
      state.selection
    ) {
      processRequest(state.lastAction, state.customPrompt || undefined)
    }
  }, [state.status, state.lastAction, state.selection, state.customPrompt, processRequest])

  // Handle send to chat
  const handleSendToChat = useCallback(
    (text: string) => {
      if (onSendToChat) {
        const prefix = t('aiAssist.chat.sendPrefix')
        onSendToChat(`${prefix}\n\n> ${text}`)
      }
    },
    [onSendToChat, t]
  )

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {children}

      {/* Floating toolbar for selection actions */}
      <FloatingToolbar onSendToChat={handleSendToChat} />

      {/* Command palette for Ctrl+K */}
      <CommandPalette
        open={isPaletteOpen}
        onClose={closePalette}
        position={palettePosition ? { top: palettePosition as unknown as number, left: 0 } : undefined}
      />

      {/* Inline diff display */}
      {state.activeDiff && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="pointer-events-auto">
            <InlineDiff
              diff={state.activeDiff}
              isStreaming={state.status === 'generating'}
              streamingContent={state.accumulatedContent}
              className="mx-4 my-2"
            />
          </div>
        </div>
      )}

      {/* Shortcut hint */}
      {!state.selection && state.status === 'idle' && (
        <div className="absolute bottom-2 right-2 text-xs text-text-muted opacity-50">
          {t('aiAssist.shortcut.hint', { shortcut: shortcutDisplayText })}
        </div>
      )}
    </div>
  )
}

/**
 * Wrapper component that provides the AI Assist context
 */
export function AIAssistEditorWrapper(props: AIAssistEditorWrapperProps) {
  return (
    <AIAssistProvider
      knowledgeBaseId={props.knowledgeBaseId}
      onSendToChat={props.onSendToChat}
    >
      <AIAssistEditorInner {...props} />
    </AIAssistProvider>
  )
}

export default AIAssistEditorWrapper
