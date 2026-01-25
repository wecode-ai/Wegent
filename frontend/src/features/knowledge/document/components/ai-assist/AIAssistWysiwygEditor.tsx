// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Wand2, Expand, FileText, Check, MessageSquare, Send, X, ArrowRight, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { toast } from 'sonner'

/**
 * AI Assist action types
 */
type AIAssistAction = 'rewrite' | 'expand' | 'summarize' | 'fix_grammar' | 'custom'

/**
 * AI Assist status
 */
type AIAssistStatus = 'idle' | 'thinking' | 'generating' | 'completed' | 'error'

/**
 * Diff result for inline editing
 */
interface DiffResult {
  original: string
  replacement: string
  from: number
  to: number
}

interface FloatingToolbarProps {
  /** Selection position */
  position: { top: number; left: number } | null
  /** Selected text */
  selectedText: string
  /** Whether the toolbar is visible */
  visible: boolean
  /** Callback when an action is clicked */
  onAction: (action: AIAssistAction, customPrompt?: string) => void
  /** Callback when send to chat is clicked */
  onSendToChat?: (text: string) => void
  /** Current status */
  status: AIAssistStatus
}

/**
 * Floating toolbar component for AI assist actions
 */
function FloatingToolbar({
  position,
  selectedText,
  visible,
  onAction,
  onSendToChat,
  status,
}: FloatingToolbarProps) {
  const { t } = useTranslation('knowledge')
  const [showCustomInput, setShowCustomInput] = useState(false)
  const [customPrompt, setCustomPrompt] = useState('')
  const customInputRef = useRef<HTMLInputElement>(null)

  // Reset custom input when visibility changes
  useEffect(() => {
    if (!visible) {
      setShowCustomInput(false)
      setCustomPrompt('')
    }
  }, [visible])

  // Focus custom input when shown
  useEffect(() => {
    if (showCustomInput && customInputRef.current) {
      customInputRef.current.focus()
    }
  }, [showCustomInput])

  if (!visible || !position || status !== 'idle') return null

  const handleCustomSubmit = () => {
    if (customPrompt.trim()) {
      onAction('custom', customPrompt.trim())
      setShowCustomInput(false)
      setCustomPrompt('')
    }
  }

  const handleSendToChat = () => {
    onSendToChat?.(selectedText)
  }

  // Calculate position to keep toolbar in viewport
  const toolbarWidth = showCustomInput ? 320 : 280
  const toolbarHeight = showCustomInput ? 84 : 44
  const padding = 8

  let left = position.left - toolbarWidth / 2
  let top = position.top - toolbarHeight - padding

  left = Math.max(padding, Math.min(left, window.innerWidth - toolbarWidth - padding))
  if (top < padding) {
    top = position.top + 24 + padding
  }

  return createPortal(
    <div
      data-ai-assist-toolbar
      className="fixed z-[9999] animate-in fade-in-0 zoom-in-95 duration-150"
      style={{ top, left }}
    >
      <div className="flex flex-col bg-surface border border-border rounded-lg shadow-md overflow-hidden">
        <div className="flex items-center gap-1 p-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onAction('rewrite')}
                className="h-8 w-8 p-0"
              >
                <Wand2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('aiAssist.toolbar.rewrite')}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onAction('expand')}
                className="h-8 w-8 p-0"
              >
                <Expand className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('aiAssist.toolbar.expand')}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onAction('summarize')}
                className="h-8 w-8 p-0"
              >
                <FileText className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('aiAssist.toolbar.summarize')}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onAction('fix_grammar')}
                className="h-8 w-8 p-0"
              >
                <Check className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('aiAssist.toolbar.fixGrammar')}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowCustomInput(!showCustomInput)}
                className={cn('h-8 w-8 p-0', showCustomInput && 'bg-primary/10')}
              >
                <MessageSquare className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('aiAssist.toolbar.custom')}
            </TooltipContent>
          </Tooltip>

          {onSendToChat && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleSendToChat}
                  className="h-8 w-8 p-0"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('aiAssist.toolbar.sendToChat')}
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {showCustomInput && (
          <div className="flex items-center gap-2 px-2 pb-2 pt-1 border-t border-border">
            <Input
              ref={customInputRef}
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleCustomSubmit()
                } else if (e.key === 'Escape') {
                  setShowCustomInput(false)
                  setCustomPrompt('')
                }
              }}
              placeholder={t('aiAssist.customPrompt.placeholder')}
              className="h-8 text-sm flex-1"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowCustomInput(false)
                setCustomPrompt('')
              }}
              className="h-8 w-8 p-0 text-text-muted hover:text-text-primary"
            >
              <X className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              onClick={handleCustomSubmit}
              disabled={!customPrompt.trim()}
              className="h-8 px-2"
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

interface InlineDiffProps {
  diff: DiffResult
  isStreaming: boolean
  streamingContent: string
  onAccept: () => void
  onReject: () => void
  onRegenerate: () => void
  status: AIAssistStatus
}

/**
 * Inline diff component showing original vs AI-generated content
 */
function InlineDiff({
  diff,
  isStreaming,
  streamingContent,
  onAccept,
  onReject,
  onRegenerate,
  status,
}: InlineDiffProps) {
  const { t } = useTranslation('knowledge')

  const displayContent = isStreaming ? streamingContent : diff.replacement

  return (
    <div className="inline-diff rounded-lg border border-border bg-surface overflow-hidden my-2">
      <div className="p-3 font-mono text-sm leading-relaxed">
        {/* Show original as deleted */}
        <div className="mb-2">
          <span className="bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300 line-through px-1 rounded">
            {diff.original}
          </span>
        </div>
        {/* Show replacement as added */}
        <div>
          <span className="bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 px-1 rounded">
            {displayContent}
          </span>
          {isStreaming && (
            <span className="inline-flex items-center ml-1">
              <span className="animate-pulse">▌</span>
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-border bg-fill-tert">
        {isStreaming || status === 'thinking' || status === 'generating' ? (
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <Spinner className="h-4 w-4" />
            <span>
              {status === 'thinking'
                ? t('aiAssist.status.thinking')
                : t('aiAssist.status.generating')}
            </span>
          </div>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={onReject}
              className="h-8 text-text-muted hover:text-red-600"
            >
              <X className="h-4 w-4 mr-1" />
              {t('aiAssist.diff.reject')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRegenerate}
              className="h-8 text-text-muted hover:text-primary"
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              {t('aiAssist.diff.regenerate')}
            </Button>
            <Button size="sm" onClick={onAccept} className="h-8">
              <Check className="h-4 w-4 mr-1" />
              {t('aiAssist.diff.accept')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

interface AIAssistWysiwygEditorProps {
  /** Initial content */
  initialContent: string
  /** Content change callback */
  onChange?: (content: string) => void
  /** Save callback */
  onSave?: (content: string) => void
  /** Close callback */
  onClose?: () => void
  /** Additional class name */
  className?: string
  /** Read only mode */
  readOnly?: boolean
  /** Default vim mode */
  defaultVimMode?: boolean
  /** Knowledge base ID for AI search */
  knowledgeBaseId?: number
  /** Callback when send to chat is triggered */
  onSendToChat?: (content: string) => void
}

/**
 * WYSIWYG Editor with AI Assist capabilities
 *
 * Features:
 * - Text selection triggers floating toolbar
 * - AI actions: rewrite, expand, summarize, fix grammar, custom
 * - Inline diff for reviewing AI changes
 * - Accept/reject/regenerate actions
 */
export function AIAssistWysiwygEditor({
  initialContent,
  onChange,
  onSave,
  onClose,
  className,
  readOnly = false,
  defaultVimMode,
  knowledgeBaseId,
  onSendToChat,
}: AIAssistWysiwygEditorProps) {
  const { t } = useTranslation('knowledge')
  const [content, setContent] = useState(initialContent)
  const [selection, setSelection] = useState<{
    text: string
    from: number
    to: number
    position: { top: number; left: number }
  } | null>(null)
  const [status, setStatus] = useState<AIAssistStatus>('idle')
  const [activeDiff, setActiveDiff] = useState<DiffResult | null>(null)
  const [streamingContent, setStreamingContent] = useState('')
  const [lastAction, setLastAction] = useState<{ action: AIAssistAction; prompt?: string } | null>(
    null
  )

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const showTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Update content when initialContent changes
  useEffect(() => {
    setContent(initialContent)
  }, [initialContent])

  // Handle content change
  const handleContentChange = useCallback(
    (newContent: string) => {
      setContent(newContent)
      onChange?.(newContent)
    },
    [onChange]
  )

  // Handle text selection
  const handleSelectionChange = useCallback(() => {
    if (readOnly || status !== 'idle') return

    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current)
    }

    showTimeoutRef.current = setTimeout(() => {
      const textarea = textareaRef.current
      if (!textarea) return

      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const selectedText = content.substring(start, end).trim()

      if (selectedText.length > 0) {
        // Get position for toolbar
        const rect = textarea.getBoundingClientRect()
        const lineHeight = 20 // Approximate line height
        const charWidth = 8 // Approximate character width

        // Calculate approximate position
        const textBefore = content.substring(0, start)
        const lines = textBefore.split('\n')
        const currentLine = lines.length - 1
        const currentCol = lines[lines.length - 1].length

        const top = rect.top + currentLine * lineHeight
        const left = rect.left + currentCol * charWidth

        setSelection({
          text: selectedText,
          from: start,
          to: end,
          position: { top, left: Math.min(left, rect.right - 50) },
        })
      } else {
        setSelection(null)
      }
    }, 300)
  }, [content, readOnly, status])

  // Handle AI action
  const handleAIAction = useCallback(
    async (action: AIAssistAction, customPrompt?: string) => {
      if (!selection) return

      setLastAction({ action, prompt: customPrompt })
      setStatus('thinking')
      setStreamingContent('')

      // Cancel any previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      abortControllerRef.current = new AbortController()

      try {
        const response = await fetch('/api/v1/ai-assist/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            content: selection.text,
            custom_prompt: customPrompt,
            knowledge_base_id: knowledgeBaseId,
          }),
          signal: abortControllerRef.current.signal,
        })

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`)
        }

        const reader = response.body?.getReader()
        if (!reader) throw new Error('No response body')

        setStatus('generating')
        const decoder = new TextDecoder()
        let accumulated = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const chunk = decoder.decode(value)
          const lines = chunk.split('\n')

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6))
                if (data.type === 'chunk') {
                  accumulated += data.content || ''
                  setStreamingContent(accumulated)
                } else if (data.type === 'done') {
                  // Create diff result
                  setActiveDiff({
                    original: selection.text,
                    replacement: accumulated,
                    from: selection.from,
                    to: selection.to,
                  })
                  setStatus('completed')
                } else if (data.type === 'error') {
                  throw new Error(data.error || 'Unknown error')
                }
              } catch (parseError) {
                // Skip non-JSON lines
              }
            }
          }
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') return

        console.error('AI assist error:', error)
        toast.error(t('aiAssist.errors.processingFailed'))
        setStatus('error')
        setTimeout(() => setStatus('idle'), 2000)
      }
    },
    [selection, knowledgeBaseId, t]
  )

  // Accept diff
  const handleAcceptDiff = useCallback(() => {
    if (!activeDiff) return

    const newContent =
      content.substring(0, activeDiff.from) +
      activeDiff.replacement +
      content.substring(activeDiff.to)

    handleContentChange(newContent)
    setActiveDiff(null)
    setSelection(null)
    setStatus('idle')
    toast.success(t('aiAssist.diff.accept'))
  }, [activeDiff, content, handleContentChange, t])

  // Reject diff
  const handleRejectDiff = useCallback(() => {
    setActiveDiff(null)
    setStatus('idle')
  }, [])

  // Regenerate
  const handleRegenerate = useCallback(() => {
    if (lastAction && selection) {
      handleAIAction(lastAction.action, lastAction.prompt)
    }
  }, [lastAction, selection, handleAIAction])

  // Handle send to chat
  const handleSendToChat = useCallback(
    (text: string) => {
      if (onSendToChat) {
        const prefix = t('aiAssist.chat.sendPrefix')
        onSendToChat(`${prefix}\n\n> ${text}`)
        setSelection(null)
        toast.success(t('aiAssist.chat.inserted'))
      }
    },
    [onSendToChat, t]
  )

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Tab key inserts spaces
      if (e.key === 'Tab') {
        e.preventDefault()
        const textarea = textareaRef.current
        if (!textarea) return

        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const newContent = content.substring(0, start) + '  ' + content.substring(end)
        handleContentChange(newContent)

        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 2
        })
      }
    },
    [content, handleContentChange]
  )

  return (
    <div className={cn('ai-assist-editor flex flex-col h-full', className)}>
      {/* Editor textarea */}
      <div className="flex-1 relative">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => handleContentChange(e.target.value)}
          onSelect={handleSelectionChange}
          onKeyDown={handleKeyDown}
          className={cn(
            'w-full h-full p-4 resize-none outline-none',
            'font-mono text-sm leading-relaxed',
            'text-text-primary bg-white dark:bg-gray-900',
            'placeholder:text-text-muted',
            'border border-border rounded-lg',
            'focus:ring-2 focus:ring-primary/20 focus:border-primary',
            readOnly && 'cursor-default'
          )}
          placeholder="Enter markdown content..."
          readOnly={readOnly}
          spellCheck={false}
        />

        {/* Inline diff overlay */}
        {activeDiff && (
          <div className="absolute inset-x-4 top-4">
            <InlineDiff
              diff={activeDiff}
              isStreaming={status === 'generating'}
              streamingContent={streamingContent}
              onAccept={handleAcceptDiff}
              onReject={handleRejectDiff}
              onRegenerate={handleRegenerate}
              status={status}
            />
          </div>
        )}
      </div>

      {/* Floating toolbar */}
      <FloatingToolbar
        position={selection?.position || null}
        selectedText={selection?.text || ''}
        visible={!!selection && status === 'idle'}
        onAction={handleAIAction}
        onSendToChat={onSendToChat ? handleSendToChat : undefined}
        status={status}
      />
    </div>
  )
}

export default AIAssistWysiwygEditor
