// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useMemo } from 'react'
import type { ThinkingStep, MessageBlock, ToolPair } from './types'
import { useToolExtraction } from './hooks/useToolExtraction'
import { ToolBlock } from './components/ToolBlock'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { normalizeToolName } from './utils/toolExtractor'
import { useTranslation } from '@/hooks/useTranslation'
import { processCitePatterns } from '../../../utils/processCitePatterns'
import type { GeminiAnnotation } from '@/types/socket'
import VideoPlayer from '../VideoPlayer'
import { ImageGallery } from '../ImageGallery'
import { AskUserForm } from '../../clarification'
import type { AskUserFormData } from '@/types/api'
import { blockRendererRegistry } from '../block-registry'
import {
  SubscriptionPreviewCard,
  type SubscriptionPreviewBlock,
} from '../../subscription/SubscriptionPreviewCard'
// Import to register prompt optimization block renderer
import '@/features/prompt-optimization/block-renderer'

const normalizeForComparison = (value: string): string =>
  value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

const isInteractiveFormDuplicateContent = (text: string, forms: AskUserFormData[]): boolean => {
  if (!text.trim()) return false

  const normalizedText = normalizeForComparison(text)
  return forms.some(form => {
    const matchedQuestions = form.questions.filter(question => {
      const normalizedQuestion = normalizeForComparison(question.question)
      return normalizedQuestion && normalizedText.includes(normalizedQuestion)
    }).length

    if (matchedQuestions === 0) return false
    if (form.questions.length === 1) return true
    return matchedQuestions >= 2
  })
}

const isRenderableInteractiveQuestion = (question: Record<string, unknown>): boolean => {
  const questionText = typeof question.question === 'string' ? question.question.trim() : ''
  return questionText.length > 0
}

interface MixedContentViewProps {
  thinking: ThinkingStep[] | null
  content: string
  taskStatus?: string // For future use (e.g., showing pending states)
  theme: 'light' | 'dark'
  blocks?: MessageBlock[] // NEW: Block-based rendering support
  annotations?: GeminiAnnotation[]
  /** Optional callback when user wants to use a generated image as reference for follow-up */
  onUseAsReference?: (item: import('../ImageGallery').ImageItem) => void
  /** Task ID for AskUserForm context */
  taskId?: number
  /** Subtask ID for AskUserForm context */
  subtaskId?: number
  /** Current message index for AskUserForm submission tracking */
  currentMessageIndex?: number
  /** Callback when user submits an ask_user_question form - receives pre-formatted message string */
  onAskUserSubmit?: (askId: string, formattedMessage: string) => void
}

/**
 * MixedContentView Component
 *
 * Renders content and tool calls in chronological order.
 * Supports two modes:
 * 1. Block-based (new): Uses blocks array for chronological mixed rendering
 * 2. Thinking-based (legacy): Extracts tools from thinking array
 */
const MixedContentView = memo(function MixedContentView({
  thinking,
  content,
  taskStatus,
  theme,
  blocks,
  annotations,
  onUseAsReference,
  taskId,
  subtaskId,
  currentMessageIndex,
  onAskUserSubmit,
}: MixedContentViewProps) {
  const { t } = useTranslation('chat')
  // Extract tools from thinking (legacy mode)
  const { toolGroups } = useToolExtraction(thinking)

  // Create a map of tool_use_id to ToolPair for quick lookup (legacy mode)
  const toolMap = useMemo(() => {
    const map = new Map()
    toolGroups.forEach(group => {
      group.tools.forEach(tool => {
        map.set(tool.toolUseId, tool)
      })
    })
    return map
  }, [toolGroups])

  // Build mixed content array - prefer blocks if available
  const mixedItems = useMemo(() => {
    // NEW: Block-based rendering (preferred)
    if (blocks && blocks.length > 0) {
      const mapped = blocks
        .map(block => {
          if (block.type === 'text') {
            // CRITICAL FIX: When page refreshes during streaming, block.content may be empty
            // but the actual content is in the `content` prop (from cached_content).
            // We need to use the `content` prop as fallback when block.content is empty.
            let textContent = block.content || ''

            // If block.content is empty but we have content prop, use it
            // This handles the page refresh recovery case
            if (!textContent && content) {
              // Handle ${$$}$ separator - only show the result part (after separator)
              if (content.includes('${$$}$')) {
                const parts = content.split('${$$}$')
                textContent = parts[1] || ''
              } else {
                textContent = content
              }
            }

            return {
              type: 'content' as const,
              content: textContent,
              blockId: block.id,
            }
          } else if (block.type === 'video') {
            // Video block - render VideoPlayer component
            return {
              type: 'video' as const,
              blockId: block.id,
              isPlaceholder: block.is_placeholder ?? false,
              videoUrl: block.video_url || '',
              thumbnail: block.video_thumbnail,
              duration: block.video_duration,
              attachmentId: block.video_attachment_id,
              progress: block.video_progress ?? 0,
              status: block.status,
              message: block.content, // Progress message
            }
          } else if (block.type === 'image') {
            // Image block - render ImageGallery component
            return {
              type: 'image' as const,
              blockId: block.id,
              isPlaceholder: block.is_placeholder ?? false,
              imageUrls: block.image_urls || [],
              imageAttachmentIds: block.image_attachment_ids || [],
              imageCount: block.image_count ?? 0,
              status: block.status,
              message: block.content, // Progress message
            }
          } else if (block.type === 'subscription_preview') {
            // Subscription preview block - render SubscriptionPreviewCard
            return {
              type: 'subscription_preview' as const,
              data: block as unknown as SubscriptionPreviewBlock,
              blockId: block.id,
              status: block.status,
            }
          } else if (block.type === 'tool') {
            const input =
              block.tool_input && typeof block.tool_input === 'object'
                ? (block.tool_input as Record<string, unknown>)
                : null
            const rawQuestions = Array.isArray(input?.questions)
              ? (input.questions as Array<Record<string, unknown>>).filter(
                  isRenderableInteractiveQuestion
                )
              : []
            const hasRenderableQuestions = rawQuestions.length > 0

            // Only render an interactive form when the block carries actual questions.
            // The raw MCP tool block may exist with empty `{}` input while a synthetic
            // fallback block already contains the complete question payload.
            if (block.tool_name?.includes('interactive_form_question') && hasRenderableQuestions) {
              // Helper function to parse boolean values (handles string "True"/"False" from AI)
              const parseBoolean = (value: unknown, defaultValue: boolean): boolean => {
                if (typeof value === 'boolean') return value
                if (typeof value === 'string') {
                  const lower = value.toLowerCase()
                  if (lower === 'true') return true
                  if (lower === 'false') return false
                }
                return defaultValue
              }

              // Try to extract ask_id from tool_output first (server-generated),
              // then from tool_input.ask_id, finally fallback to tool_use_id
              let askId = block.tool_use_id || block.id
              if (block.tool_output) {
                const output =
                  typeof block.tool_output === 'string'
                    ? (() => {
                        try {
                          return JSON.parse(block.tool_output)
                        } catch {
                          return {}
                        }
                      })()
                    : block.tool_output
                if (output && typeof output === 'object' && 'ask_id' in output) {
                  askId = (output as Record<string, unknown>).ask_id as string
                }
              }
              // Also check if ask_id is in the input (for some implementations)
              if (input?.ask_id && typeof input.ask_id === 'string') {
                askId = input.ask_id
              }

              const parsedQuestions = rawQuestions.map(q => {
                const qHasOptions = Array.isArray(q.options) && (q.options as unknown[]).length > 0
                const qInputType = qHasOptions ? 'choice' : 'text'
                return {
                  id: (q.id as string) || '',
                  question: (q.question as string) || '',
                  input_type: (q.input_type as 'choice' | 'text') || qInputType,
                  options: qHasOptions
                    ? (
                        q.options as Array<{
                          label: string
                          value: string
                          recommended?: unknown
                        }>
                      ).map(opt => ({
                        label: opt.label,
                        value: opt.value,
                        recommended: parseBoolean(opt.recommended, false),
                      }))
                    : null,
                  multi_select: parseBoolean(q.multi_select, false),
                  required: parseBoolean(q.required, true),
                  default: (q.default as string[]) || null,
                  placeholder: (q.placeholder as string) || null,
                }
              })

              // Parse tool_output for timeout detection
              const parsedToolOutput = block.tool_output
                ? ((typeof block.tool_output === 'string'
                    ? (() => {
                        try {
                          return JSON.parse(block.tool_output)
                        } catch {
                          return null
                        }
                      })()
                    : block.tool_output) as Record<string, unknown> | null)
                : null

              const askUserData: AskUserFormData = {
                type: 'interactive_form_question',
                ask_id: askId,
                tool_use_id: block.tool_use_id || null, // Pass tool_use_id for fallback lookup
                task_id: taskId || 0,
                subtask_id: subtaskId || 0,
                questions: parsedQuestions,
                // Pass tool_output so AskUserForm can detect timeout vs normal completion
                tool_output: parsedToolOutput,
              }
              return {
                type: 'interactive_form_question' as const,
                data: askUserData,
                blockId: block.id,
                status: block.status,
              }
            }
            if (block.tool_name?.includes('interactive_form_question')) {
              return null
            }
            // Check for custom block renderers first (e.g., prompt optimization)
            // This allows feature modules to register their own block renderers
            const customRenderer = blockRendererRegistry.findRenderer(block)
            if (customRenderer) {
              return {
                type: 'custom' as const,
                blockId: block.id,
                render: () => customRenderer.render({ block, isLastBlock: false }),
              }
            }
            // Normalize tool name to match preset components (e.g., sandbox_write_file -> Write)
            const normalizedToolName = normalizeToolName(block.tool_name || 'unknown')
            const toolPair = {
              toolUseId: block.tool_use_id || block.id,
              toolName: normalizedToolName,
              displayName: block.display_name, // Pass display_name from block
              status:
                (block.status as 'pending' | 'streaming' | 'invoking' | 'done' | 'error') || 'done',
              toolUse: {
                title: `Using ${normalizedToolName}`,
                next_action: 'continue',
                tool_use_id: block.tool_use_id,
                details: {
                  type: 'tool_use',
                  tool_name: normalizedToolName,
                  status: 'started',
                  input: block.tool_input,
                },
              },
              toolResult: block.tool_output
                ? {
                    title: `Result from ${normalizedToolName}`,
                    next_action: 'continue',
                    tool_use_id: block.tool_use_id,
                    details: {
                      type: 'tool_result',
                      tool_name: normalizedToolName,
                      status: block.status === 'error' ? 'failed' : 'completed',
                      content:
                        typeof block.tool_output === 'string'
                          ? block.tool_output
                          : JSON.stringify(block.tool_output),
                      output: block.tool_output,
                    },
                  }
                : undefined,
            }
            return {
              type: 'tool' as const,
              tool: toolPair,
              blockId: block.id,
            }
          }
          return null
        })
        .filter(Boolean)

      // CRITICAL FIX: When blocks exist but no text blocks, we need to also render
      // the main content. This handles the case where:
      // 1. chat:block_created creates a tool block
      // 2. chat:chunk sends text content (accumulated in message.content)
      // 3. Without this fix, only tool blocks are rendered, text content is lost
      const hasTextBlock = blocks.some(b => b.type === 'text')
      if (!hasTextBlock && content && content.trim()) {
        // Handle ${$$}$ separator - only show the result part (after separator)
        // This separator is used to split prompt and result in some message formats
        let contentToRender = content
        if (content.includes('${$$}$')) {
          const parts = content.split('${$$}$')
          contentToRender = parts[1] || ''
        }

        if (contentToRender && contentToRender.trim()) {
          // Add main content at the end (after tool blocks)
          mapped.push({
            type: 'content' as const,
            content: contentToRender,
            blockId: 'main-content',
          })
        }
      }

      const interactiveForms = mapped
        .filter(item => item?.type === 'interactive_form_question')
        .map(item => item.data)

      if (interactiveForms.length > 0) {
        return mapped.filter(item => {
          if (!item) return false
          if (item.type !== 'content') return true
          return !isInteractiveFormDuplicateContent(item.content, interactiveForms)
        })
      }

      return mapped
    }

    // LEGACY: Thinking-based rendering (fallback for old messages)
    if (!thinking?.length) {
      // No thinking data, just show content if not empty
      if (content && content.trim()) {
        return [{ type: 'content' as const, content }]
      }
      return []
    }

    const items: Array<
      | { type: 'content'; content: string }
      | { type: 'tool'; tool: ToolPair }
      | {
          type: 'interactive_form_question'
          data: AskUserFormData
          blockId: string
          status: string
        }
      | {
          type: 'subscription_preview'
          data: SubscriptionPreviewBlock
          blockId: string
          status: string
        }
    > = []

    let hasShownMainContent = false

    thinking.forEach(step => {
      const stepType = step.details?.type

      // Show main content before first tool if not shown yet
      if (!hasShownMainContent && stepType === 'tool_use') {
        if (content && content.trim()) {
          items.push({ type: 'content', content })
          hasShownMainContent = true
        }
      }

      if (stepType === 'tool_use') {
        // Find the tool pair
        const toolUseId = step.tool_use_id || step.run_id
        const tool = toolUseId ? toolMap.get(toolUseId) : null

        if (tool) {
          items.push({ type: 'tool', tool })
        }
      } else if (stepType === 'assistant' || stepType === 'user') {
        // Text content from thinking steps
        const text = step.details?.content || step.title
        if (text && text.trim() && typeof text === 'string') {
          items.push({ type: 'content', content: text })
        }
      }
    })

    // If main content wasn't shown yet (no tools), show it at the end
    if (!hasShownMainContent && content && content.trim()) {
      items.push({ type: 'content', content })
    }

    return items
  }, [blocks, thinking, content, toolMap, taskId, subtaskId])

  // Check if we should show "Processing..." indicator
  const shouldShowProcessing = useMemo(() => {
    // Show processing indicator whenever task is running
    // This ensures users always see feedback that the task is being processed
    return taskStatus === 'RUNNING'
  }, [taskStatus])

  // Merge consecutive same tools into groups with count and collect all merged tools
  const mergedItems = useMemo(() => {
    type ToolItem = { type: 'tool'; tool: ToolPair; blockId: string }
    type MergedToolItem = ToolItem & { count: number; mergedTools: ToolPair[] }
    type ResultItem = (typeof mixedItems)[number] & { count?: number; mergedTools?: ToolPair[] }

    const result: ResultItem[] = []

    for (let i = 0; i < mixedItems.length; i++) {
      const item = mixedItems[i]
      if (!item) continue

      if (item.type === 'tool') {
        // Check if we can merge with the previous item
        const lastItem = result[result.length - 1]
        if (lastItem && lastItem.type === 'tool' && lastItem.tool.toolName === item.tool.toolName) {
          // Merge: increment count and add to mergedTools array
          const mergedItem = lastItem as MergedToolItem
          mergedItem.count = (mergedItem.count || 1) + 1
          if (!mergedItem.mergedTools) {
            mergedItem.mergedTools = [mergedItem.tool]
          }
          mergedItem.mergedTools.push(item.tool)
        } else {
          // New tool or different tool name
          result.push({ ...item, count: 1, mergedTools: [item.tool] })
        }
      } else {
        // Non-tool items are added as-is
        result.push(item)
      }
    }

    return result
  }, [mixedItems])

  return (
    <div className="space-y-3">
      {mergedItems.map((item, index) => {
        // Null check after filter
        if (!item) {
          return null
        }

        if (item.type === 'content') {
          // Skip empty content or non-string content
          if (!item.content || typeof item.content !== 'string' || !item.content.trim()) {
            return null
          }
          const key = 'blockId' in item ? item.blockId : `content-${index}`
          const textContent =
            annotations && annotations.length > 0
              ? processCitePatterns(item.content, annotations)
              : item.content
          return (
            <div key={key} className="text-sm">
              <EnhancedMarkdown source={textContent} theme={theme} />
            </div>
          )
        } else if (item.type === 'video') {
          // Render video block using VideoPlayer component
          return (
            <div key={item.blockId} className="space-y-2">
              <VideoPlayer
                videoUrl={item.videoUrl}
                thumbnail={item.thumbnail ?? undefined}
                duration={item.duration ?? undefined}
                attachmentId={item.attachmentId ?? undefined}
                isPlaceholder={item.isPlaceholder}
                progress={item.progress}
              />
              {/* Show progress message if available */}
              {item.isPlaceholder && item.message && (
                <div className="text-xs text-text-muted">{item.message}</div>
              )}
            </div>
          )
        } else if (item.type === 'image') {
          // Render image block using ImageGallery component
          return (
            <div key={item.blockId} className="space-y-2">
              {item.isPlaceholder ? (
                // Show loading state for placeholder images
                <div className="flex items-center gap-3 p-4 rounded-lg bg-surface border border-border">
                  <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <div className="h-4 w-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium text-text-primary">
                      {t('image.generating') || 'Generating images...'}
                    </div>
                    {item.message && (
                      <div className="text-xs text-text-muted mt-1">{item.message}</div>
                    )}
                  </div>
                </div>
              ) : item.imageUrls && item.imageUrls.length > 0 ? (
                // Show generated images
                <ImageGallery
                  images={item.imageUrls.map((url: string, i: number) => ({
                    url,
                    attachmentId: item.imageAttachmentIds?.[i],
                  }))}
                  onUseAsReference={onUseAsReference}
                />
              ) : null}
            </div>
          )
        } else if (item.type === 'custom') {
          // Render custom block using the registered renderer
          return <div key={item.blockId}>{item.render()}</div>
        } else if (item.type === 'interactive_form_question') {
          // Render ask_user_question form for interactive user input
          // pb-4 ensures enough space between the form and the absolute-positioned BubbleTools below
          return (
            <div key={item.blockId} className="pb-4">
              <AskUserForm
                data={item.data}
                taskId={taskId || 0}
                currentMessageIndex={currentMessageIndex || 0}
                blockStatus={item.status}
                onSubmit={onAskUserSubmit}
              />
            </div>
          )
        } else if (item.type === 'subscription_preview') {
          // Render subscription preview card with confirm/cancel buttons
          return (
            <div key={item.blockId} className="pb-4">
              <SubscriptionPreviewCard data={item.data} />
            </div>
          )
        } else if (item.type === 'tool') {
          const key = 'blockId' in item ? item.blockId : `tool-${item.tool.toolUseId}`
          const count = 'count' in item ? item.count : 1
          const mergedTools = 'mergedTools' in item ? item.mergedTools : undefined
          return (
            <ToolBlock
              key={key}
              tool={item.tool}
              defaultExpanded={false}
              count={count}
              mergedTools={mergedTools}
            />
          )
        }
        return null
      })}

      {/* Show "Processing..." indicator when task is running and last block is complete */}
      {shouldShowProcessing && (
        <div className="flex items-center gap-2 text-xs text-text-muted italic px-2 py-1">
          <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
          <span>{t('thinking.processing') || 'Processing...'}</span>
        </div>
      )}
    </div>
  )
})

export default MixedContentView
