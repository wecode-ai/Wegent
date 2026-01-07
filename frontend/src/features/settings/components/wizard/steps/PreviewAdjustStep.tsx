// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useRef } from 'react'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import {
  RefreshCw,
  MessageSquare,
  FileText,
  Wand2,
  Cpu,
  Sparkles,
  X,
  Quote,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { modelApis, type UnifiedModel } from '@/apis/models'
import type { TestConversation } from '../types'
import type { ModelRecommendation } from '@/apis/wizard'
import GeneratingLoader from './GeneratingLoader'
import {
  MessageBubble,
  type Message,
  type ParagraphAction,
} from '@/features/tasks/components/message'
import { useTheme } from '@/features/theme/ThemeProvider'
import '../wizard-animations.css'

// Popover content component for paragraph optimization
// This is a separate component to allow using React hooks
interface ParagraphOptimizePopoverProps {
  paragraphText: string
  onClose: () => void
  onIteratePrompt: (feedback: string, selectedText?: string) => Promise<void>
  isIteratingPrompt: boolean
  t: (key: string) => string
}

function ParagraphOptimizePopover({
  paragraphText,
  onClose,
  onIteratePrompt,
  isIteratingPrompt,
  t,
}: ParagraphOptimizePopoverProps) {
  const [localFeedback, setLocalFeedback] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async () => {
    if (!localFeedback.trim() || isSubmitting) return
    setIsSubmitting(true)
    try {
      // Pass feedback and selectedText separately - let the backend handle the context
      await onIteratePrompt(localFeedback, paragraphText || undefined)
      // Close popover after successful optimization
      onClose()
    } catch (error) {
      console.error('Failed to iterate prompt:', error)
      setIsSubmitting(false)
    }
  }

  // Determine if we're in loading state (either local submitting or parent iterating)
  const isLoading = isSubmitting || isIteratingPrompt

  return (
    <div className="p-3 space-y-3">
      {/* Header with close button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isLoading ? (
            <Spinner className="w-4 h-4 text-primary" />
          ) : (
            <Wand2 className="w-4 h-4 text-primary" />
          )}
          <span className="text-sm font-medium">
            {isLoading ? t('wizard:optimizing') : t('wizard:optimize_paragraph')}
          </span>
        </div>
        {!isLoading && (
          <button
            onClick={onClose}
            className="p-1 hover:bg-hover rounded transition-colors"
            aria-label="Close"
          >
            <X className="w-3.5 h-3.5 text-text-muted" />
          </button>
        )}
      </div>

      {/* Quoted text - only show when paragraphText is provided */}
      {paragraphText && (
        <div className="bg-muted/50 border border-border rounded-md p-2">
          <div className="flex items-start gap-2">
            <Quote className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />
            <p className="text-xs text-text-primary line-clamp-3 italic">
              &ldquo;{paragraphText}&rdquo;
            </p>
          </div>
        </div>
      )}

      {/* Loading state overlay */}
      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-4 gap-2">
          <Spinner className="w-6 h-6 text-primary" />
          <p className="text-sm text-text-muted">{t('wizard:optimizing_prompt')}</p>
        </div>
      ) : (
        <>
          {/* Feedback input */}
          <Textarea
            value={localFeedback}
            onChange={e => setLocalFeedback(e.target.value)}
            placeholder={t('wizard:iterate_placeholder')}
            className="min-h-[60px] text-sm resize-none"
            autoFocus
            disabled={isLoading}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit()
              }
            }}
          />

          {/* Submit button */}
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              disabled={isLoading || !localFeedback.trim()}
            >
              <RefreshCw className="w-3.5 h-3.5 mr-1" />
              {t('wizard:iterate_button')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

interface PreviewAdjustStepProps {
  systemPrompt: string
  testConversations: TestConversation[]
  isTestingPrompt: boolean
  isIteratingPrompt: boolean
  selectedModel: ModelRecommendation | null
  onTestPrompt: (testMessage: string) => Promise<void>
  onIteratePrompt: (feedback: string, selectedText?: string) => Promise<void>
  onPromptChange: (prompt: string) => void
  onModelChange: (model: ModelRecommendation | null) => void
  onClearConversations: () => void
  isLoading: boolean
  promptRefreshed?: boolean
  sampleTestMessage?: string
}

export default function PreviewAdjustStep({
  systemPrompt,
  testConversations,
  isTestingPrompt,
  isIteratingPrompt,
  selectedModel,
  onTestPrompt,
  onIteratePrompt,
  onPromptChange,
  onModelChange,
  onClearConversations,
  isLoading,
  promptRefreshed = false,
  sampleTestMessage = '',
}: PreviewAdjustStepProps) {
  const { t } = useTranslation(['common', 'wizard'])
  const { theme } = useTheme()
  const [testMessage, setTestMessage] = useState(sampleTestMessage)
  const [feedbackMessage, setFeedbackMessage] = useState('')
  const [quotedText, setQuotedText] = useState('') // Quoted text from AI response
  const [availableModels, setAvailableModels] = useState<UnifiedModel[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [showRefreshSuccess, setShowRefreshSuccess] = useState(false)
  const [isFadingOut, setIsFadingOut] = useState(false) // Separate state for fade-out animation
  const [showIteratePanel, setShowIteratePanel] = useState(false) // Hidden by default
  const [isPromptExpanded, setIsPromptExpanded] = useState(false) // Prompt panel collapsed by default
  const iteratePanelRef = useRef<HTMLDivElement>(null)

  // Unified state for floating popover (used by both paragraph action and text selection)
  const [optimizePopover, setOptimizePopover] = useState<{
    isOpen: boolean
    text: string
    position: { x: number; y: number }
  }>({ isOpen: false, text: '', position: { x: 0, y: 0 } })
  const messagesAreaRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Handle prompt refresh animation when promptRefreshed changes
  useEffect(() => {
    if (promptRefreshed) {
      setIsRefreshing(true)
      setShowRefreshSuccess(true)
      setIsFadingOut(true) // Start fade-out animation

      // Get the last test message before clearing conversations
      const lastTestMessage =
        testConversations.length > 0
          ? testConversations[testConversations.length - 1].testMessage
          : ''

      // Clear conversations after a short delay for animation
      const clearTimer = setTimeout(() => {
        onClearConversations()
        setIsFadingOut(false) // Stop fade-out animation after clearing
        // Fill the input with the last test message for easy re-testing
        if (lastTestMessage) {
          setTestMessage(lastTestMessage)
        }
      }, 300)

      // End refresh animation
      const refreshTimer = setTimeout(() => {
        setIsRefreshing(false)
      }, 800)

      // Hide success message
      const successTimer = setTimeout(() => {
        setShowRefreshSuccess(false)
      }, 2500)

      return () => {
        clearTimeout(clearTimer)
        clearTimeout(refreshTimer)
        clearTimeout(successTimer)
      }
    }
  }, [promptRefreshed, onClearConversations, testConversations])

  // Update testMessage when sampleTestMessage prop changes
  useEffect(() => {
    if (sampleTestMessage && !testMessage) {
      setTestMessage(sampleTestMessage)
    }
  }, [sampleTestMessage]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load available models on mount
  useEffect(() => {
    const loadModels = async () => {
      setIsLoadingModels(true)
      try {
        // Get models compatible with Chat shell type, filtered to LLM category only
        const response = await modelApis.getUnifiedModels('Chat', false, 'all', undefined, 'llm')
        setAvailableModels(response.data || [])

        // If no model is selected and we have models, select the first one
        if (!selectedModel && response.data && response.data.length > 0) {
          const firstModel = response.data[0]
          onModelChange({
            model_name: firstModel.name,
            model_id: firstModel.modelId || undefined,
            reason: '',
            confidence: 1.0,
          })
        }
      } catch (error) {
        console.error('Failed to load models:', error)
      } finally {
        setIsLoadingModels(false)
      }
    }
    loadModels()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Handle click outside to close iterate panel
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (iteratePanelRef.current && !iteratePanelRef.current.contains(event.target as Node)) {
        setShowIteratePanel(false)
      }
    }

    if (showIteratePanel) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showIteratePanel])

  // Handle click outside to close optimize popover (but not during optimization)
  useEffect(() => {
    const handleClickOutsidePopover = (event: MouseEvent) => {
      // Don't close if we're iterating/optimizing
      if (isIteratingPrompt) return

      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setOptimizePopover(prev => ({ ...prev, isOpen: false }))
      }
    }

    if (optimizePopover.isOpen) {
      document.addEventListener('mousedown', handleClickOutsidePopover)
      return () => document.removeEventListener('mousedown', handleClickOutsidePopover)
    }
  }, [optimizePopover.isOpen, isIteratingPrompt])

  // Reference to the test input textarea
  const testInputRef = useRef<HTMLTextAreaElement>(null)
  // Reference to the "single round hint" label for popover anchoring
  const singleRoundHintRef = useRef<HTMLSpanElement>(null)

  // Helper function to open optimize popover (position is handled by CSS relative positioning)
  const openOptimizePopover = (text: string, _event?: React.MouseEvent) => {
    setOptimizePopover({
      isOpen: true,
      text,
      position: { x: 0, y: 0 }, // Position is now handled by CSS
    })
  }

  const closeOptimizePopover = () => {
    setOptimizePopover(prev => ({ ...prev, isOpen: false }))
  }

  if (isLoading) {
    return <GeneratingLoader />
  }

  const handleTestSubmit = async () => {
    if (!testMessage.trim()) return
    const messageToSend = testMessage
    // Clear input immediately before sending
    setTestMessage('')
    await onTestPrompt(messageToSend)
  }

  const handleIterateSubmit = async () => {
    if (!feedbackMessage.trim() && !quotedText.trim()) return
    // Pass feedback and selectedText separately - let the backend handle the context
    await onIteratePrompt(feedbackMessage, quotedText || undefined)
    setFeedbackMessage('')
    setQuotedText('')
  }

  const handleModelSelect = (modelName: string) => {
    const model = availableModels.find(m => m.name === modelName)
    if (model) {
      onModelChange({
        model_name: model.name,
        model_id: model.modelId || undefined,
        reason: '',
        confidence: 1.0,
      })
    }
  }

  // Handle text selection from AI message - open optimize popover
  const handleTextSelect = (selectedText: string) => {
    openOptimizePopover(selectedText)
  }

  // Get the latest conversation for single-round preview
  const latestConversation =
    testConversations.length > 0 ? testConversations[testConversations.length - 1] : null

  // Convert test conversation to Message format for MessageBubble
  const convertToMessages = (conversation: TestConversation): Message[] => {
    const messages: Message[] = []

    // User message
    messages.push({
      type: 'user',
      content: conversation.testMessage,
      timestamp: Date.now(),
    })

    // AI response (if available)
    if (conversation.modelResponse || isTestingPrompt) {
      messages.push({
        type: 'ai',
        content: conversation.modelResponse || '',
        timestamp: Date.now(),
        botName: selectedModel?.model_name || 'AI',
        isWaiting: isTestingPrompt && !conversation.modelResponse,
      })
    }

    return messages
  }

  // Paragraph action configuration for AI messages
  // When user clicks the action button on a paragraph, open the unified optimize popover
  const paragraphAction: ParagraphAction = {
    icon: <Wand2 className="w-4 h-4" />,
    tooltip: t('wizard:optimize_paragraph'),
    onAction: (paragraphText: string, event?: React.MouseEvent) => {
      openOptimizePopover(paragraphText, event)
    },
  }

  // Render the right side prompt panel content
  const renderPromptPanelContent = () => (
    <div className="h-full flex flex-col">
      {/* Panel header */}
      <div className="flex items-center justify-between p-3 border-b border-border flex-shrink-0">
        <Label className="text-sm font-medium flex items-center gap-2">
          <FileText className="w-4 h-4 text-text-secondary" />
          {t('wizard:system_prompt')}
          {showRefreshSuccess && (
            <span className="flex items-center gap-1 text-xs text-primary refresh-toast">
              <Sparkles className="w-3 h-3 refresh-success-icon" />
              {t('wizard:prompt_refreshed')}
            </span>
          )}
        </Label>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setIsPromptExpanded(false)}
        >
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      {/* Prompt editor */}
      <div
        className={`flex-1 p-3 overflow-y-auto ${isRefreshing ? 'prompt-refresh-glow prompt-refresh-sparkle' : ''}`}
      >
        <Textarea
          value={systemPrompt}
          onChange={e => onPromptChange(e.target.value)}
          className={`min-h-[200px] h-full font-mono text-sm resize-none transition-all duration-300 ${isRefreshing ? 'prompt-refreshing prompt-refresh-border' : ''}`}
          placeholder={t('wizard:system_prompt_placeholder')}
        />
      </div>

      {/* Iterate section */}
      <div className="border-t border-border p-3 flex-shrink-0 space-y-3" ref={iteratePanelRef}>
        <div className="flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium text-text-primary">{t('wizard:iterate_label')}</span>
        </div>
        <p className="text-xs text-text-muted">{t('wizard:preview_adjust_iterate_hint')}</p>

        {/* Quoted text area - shows when text is selected from AI response */}
        {quotedText && (
          <div className="relative bg-muted/50 border border-border rounded-md p-3 animate-fade-in">
            <div className="flex items-start gap-2">
              <Quote className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-text-muted mb-1">{t('wizard:quoted_text_label')}</p>
                <p className="text-sm text-text-primary line-clamp-3 italic">
                  &ldquo;{quotedText}&rdquo;
                </p>
              </div>
              <button
                onClick={() => setQuotedText('')}
                className="flex-shrink-0 p-1 hover:bg-hover rounded transition-colors"
                aria-label="Remove quote"
              >
                <X className="w-3.5 h-3.5 text-text-muted" />
              </button>
            </div>
          </div>
        )}

        {/* Hint for selecting text */}
        {!quotedText && latestConversation && (
          <p className="text-xs text-text-muted flex items-center gap-1.5">
            <Quote className="w-3 h-3" />
            {t('wizard:select_text_hint')}
          </p>
        )}

        <Textarea
          value={feedbackMessage}
          onChange={e => setFeedbackMessage(e.target.value)}
          placeholder={t('wizard:iterate_placeholder')}
          className="min-h-[80px] text-sm border-border focus:border-primary/50"
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleIterateSubmit()
            }
          }}
        />
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={handleIterateSubmit}
            disabled={isIteratingPrompt || (!feedbackMessage.trim() && !quotedText.trim())}
          >
            {isIteratingPrompt ? (
              <Spinner className="w-4 h-4" />
            ) : (
              <>
                <RefreshCw className="w-4 h-4 mr-1" />
                {t('wizard:iterate_button')}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )

  return (
    <>
      <div className="h-full flex gap-3">
        {/* Left side: Model selector + Preview (main area) */}
        <div className="flex-1 flex flex-col gap-3 min-w-0">
          {/* Model selector row */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <Label className="text-sm font-medium flex items-center gap-2 flex-shrink-0">
              <Cpu className="w-4 h-4 text-text-secondary" />
              {t('wizard:select_model')}
            </Label>
            <Select
              value={selectedModel?.model_name || ''}
              onValueChange={handleModelSelect}
              disabled={isLoadingModels}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue
                  placeholder={isLoadingModels ? t('models.loading') : t('wizard:select_model')}
                />
              </SelectTrigger>
              <SelectContent>
                {availableModels.map(model => (
                  <SelectItem key={model.name} value={model.name}>
                    <div className="flex items-center gap-2">
                      <span>{model.displayName || model.name}</span>
                      {model.type === 'public' && (
                        <span className="text-xs text-text-muted bg-muted px-1.5 py-0.5 rounded">
                          {t('models.public')}
                        </span>
                      )}
                    </div>
                  </SelectItem>
                ))}
                {availableModels.length === 0 && !isLoadingModels && (
                  <div className="px-2 py-4 text-center text-sm text-text-muted">
                    {t('wizard:no_models_available')}
                  </div>
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Preview section - takes remaining space */}
          <div className="flex flex-col gap-2 flex-1 min-h-0">
            {/* Single round hint */}
            <div className="flex items-center justify-between flex-shrink-0">
              <Label className="text-sm font-medium flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-text-secondary" />
                {t('wizard:single_round_preview')}
              </Label>
              <div className="flex items-center gap-2">
                {showRefreshSuccess && (
                  <span className="text-xs text-primary flex items-center gap-1 refresh-toast">
                    <Sparkles className="w-3 h-3" />
                    {t('wizard:preview_cleared')}
                  </span>
                )}
                <span
                  ref={singleRoundHintRef}
                  className="text-xs text-text-muted bg-muted px-2 py-1 rounded"
                >
                  {t('wizard:single_round_hint')}
                </span>
              </div>
            </div>

            {/* Conversation preview area */}
            <div
              className={`flex-1 border rounded-lg bg-surface overflow-hidden flex flex-col min-h-0 transition-all duration-300 ${isRefreshing ? 'border-primary prompt-refresh-glow' : 'border-border'}`}
            >
              {/* Messages area */}
              <div
                ref={messagesAreaRef}
                className={`flex-1 p-4 relative ${latestConversation ? 'overflow-y-auto' : 'overflow-hidden'}`}
              >
                {!latestConversation ? (
                  <div
                    className={`flex flex-col items-center justify-center h-full text-text-muted ${showRefreshSuccess && !latestConversation ? 'animate-fade-in' : ''}`}
                  >
                    {showRefreshSuccess ? (
                      <>
                        <Sparkles className="w-10 h-10 mb-3 text-primary opacity-70 refresh-success-icon" />
                        <p className="text-sm text-primary">{t('wizard:prompt_optimized')}</p>
                        <p className="text-xs mt-1">{t('wizard:try_new_prompt')}</p>
                      </>
                    ) : (
                      <>
                        <MessageSquare className="w-10 h-10 mb-3 opacity-50" />
                        <p className="text-sm">{t('wizard:test_empty')}</p>
                        <p className="text-xs mt-1">{t('wizard:preview_adjust_empty_hint')}</p>
                      </>
                    )}
                  </div>
                ) : (
                  <div className={`space-y-4 ${isFadingOut ? 'messages-fade-out' : ''}`}>
                    {convertToMessages(latestConversation).map((msg, index) => (
                      <div key={`${msg.type}-${index}`} className="relative group/message pr-10">
                        <MessageBubble
                          msg={msg}
                          index={index}
                          selectedTaskDetail={null}
                          theme={theme}
                          t={t}
                          isWaiting={msg.isWaiting}
                          onTextSelect={handleTextSelect}
                          paragraphAction={
                            msg.type === 'ai' && msg.content && !msg.isWaiting
                              ? paragraphAction
                              : undefined
                          }
                        />
                        {/* Optimize button for AI messages - always visible at top right */}
                        {msg.type === 'ai' && msg.content && !msg.isWaiting && (
                          <div className="absolute top-0 right-0">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 gap-1.5 text-xs text-text-muted hover:text-primary hover:bg-primary/10"
                              onClick={e => {
                                // Open optimize popover with the full AI response content
                                openOptimizePopover('', e)
                              }}
                            >
                              <Wand2 className="w-3.5 h-3.5" />
                              {t('wizard:optimize_response')}
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Test input area - fixed at bottom with relative positioning for popover */}
              <div className="border-t border-border p-3 bg-base relative">
                {/* Optimize popover - positioned above the input, anchored to top-right */}
                {optimizePopover.isOpen && (
                  <div
                    ref={popoverRef}
                    className="absolute z-[100] w-[320px] bg-surface border border-border rounded-lg shadow-lg animate-fade-in"
                    style={{
                      right: 0,
                      bottom: '100%',
                      marginBottom: '8px',
                    }}
                  >
                    <ParagraphOptimizePopover
                      paragraphText={optimizePopover.text}
                      onClose={closeOptimizePopover}
                      onIteratePrompt={onIteratePrompt}
                      isIteratingPrompt={isIteratingPrompt}
                      t={t}
                    />
                  </div>
                )}
                <div className="flex gap-2">
                  <Textarea
                    ref={testInputRef}
                    value={testMessage}
                    onChange={e => setTestMessage(e.target.value)}
                    placeholder={t('wizard:preview_adjust_input_placeholder')}
                    className="min-h-[50px] max-h-[80px] flex-1 text-sm resize-none"
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        handleTestSubmit()
                      }
                    }}
                  />
                  <Button
                    variant="primary"
                    onClick={handleTestSubmit}
                    disabled={isTestingPrompt || !testMessage.trim() || !selectedModel}
                    className="self-end whitespace-nowrap"
                  >
                    {isTestingPrompt ? <Spinner className="w-4 h-4" /> : t('wizard:click_to_test')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right side: Prompt panel (collapsible) */}
        {isPromptExpanded ? (
          /* Expanded prompt panel */
          <div className="w-[360px] flex-shrink-0 border border-border rounded-lg bg-surface overflow-hidden">
            {renderPromptPanelContent()}
          </div>
        ) : (
          /* Collapsed prompt toggle button - positioned at right edge */
          <div className="flex-shrink-0 flex items-start">
            <Button
              variant="outline"
              size="sm"
              className="h-auto py-3 px-2 flex flex-col items-center gap-2 border-border hover:border-primary/50 hover:bg-primary/5"
              onClick={() => setIsPromptExpanded(true)}
            >
              <ChevronLeft className="w-4 h-4" />
              <span className="writing-mode-vertical text-xs">{t('wizard:system_prompt')}</span>
              <FileText className="w-4 h-4 text-text-secondary" />
            </Button>
          </div>
        )}
      </div>
    </>
  )
}
