// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useRef } from 'react'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslation } from '@/hooks/useTranslation'
import {
  RefreshCw,
  MessageSquare,
  FileText,
  Wand2,
  Cpu,
  Sparkles,
  Zap,
  ChevronDown,
} from 'lucide-react'
import { modelApis, type UnifiedModel } from '@/apis/models'
import type { TestConversation } from '../types'
import type { ModelRecommendation, AvailableSkill, SkillRecommendation } from '@/apis/wizard'
import GeneratingLoader from './GeneratingLoader'
import SkillSelector from './SkillSelector'
import {
  MessageBubble,
  type Message,
  type ParagraphAction,
} from '@/features/tasks/components/message'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useTeamContext } from '@/contexts/TeamContext'
import { getModelFromConfig } from '@/features/settings/services/bots'
import '../wizard-animations.css'

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
  availableSkills?: AvailableSkill[]
  recommendedSkills?: SkillRecommendation[]
  selectedSkills?: string[]
  onToggleSkill?: (skillName: string) => void
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
  availableSkills = [],
  recommendedSkills = [],
  selectedSkills = [],
  onToggleSkill,
}: PreviewAdjustStepProps) {
  const { t } = useTranslation(['common', 'wizard'])
  const { theme } = useTheme()
  const [testMessage, setTestMessage] = useState(sampleTestMessage)
  const [feedbackMessage, setFeedbackMessage] = useState('')
  const [availableModels, setAvailableModels] = useState<UnifiedModel[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [showRefreshSuccess, setShowRefreshSuccess] = useState(false)
  const [isFadingOut, setIsFadingOut] = useState(false)
  const [promptPopoverOpen, setPromptPopoverOpen] = useState(false)
  const [skillsPopoverOpen, setSkillsPopoverOpen] = useState(false)
  const messagesAreaRef = useRef<HTMLDivElement>(null)
  const promptScrollRef = useRef<HTMLDivElement>(null)
  const skillsScrollRef = useRef<HTMLDivElement>(null)

  // Handle wheel event manually to ensure scrolling works in Popover
  const handleWheel = (e: React.WheelEvent, ref: React.RefObject<HTMLDivElement | null>) => {
    const list = ref.current
    if (!list) return

    // Prevent parent scrolling when scrolling within the list
    const isScrollingUp = e.deltaY < 0
    const isScrollingDown = e.deltaY > 0
    const isAtTop = list.scrollTop <= 0
    const isAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight

    if ((isScrollingUp && isAtTop) || (isScrollingDown && isAtBottom)) {
      // Allow event to propagate to parent when at boundaries
      return
    }

    // Prevent default to stop parent scrolling
    e.stopPropagation()
  }

  // Handle prompt refresh animation
  useEffect(() => {
    if (promptRefreshed) {
      setIsRefreshing(true)
      setShowRefreshSuccess(true)
      setIsFadingOut(true)

      const lastTestMessage =
        testConversations.length > 0
          ? testConversations[testConversations.length - 1].testMessage
          : ''

      const clearTimer = setTimeout(() => {
        onClearConversations()
        setIsFadingOut(false)
        if (lastTestMessage) {
          setTestMessage(lastTestMessage)
        }
      }, 300)

      const refreshTimer = setTimeout(() => {
        setIsRefreshing(false)
      }, 800)

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

  useEffect(() => {
    if (sampleTestMessage && !testMessage) {
      setTestMessage(sampleTestMessage)
    }
  }, [sampleTestMessage]) // eslint-disable-line react-hooks/exhaustive-deps

  // Get teams from context to find default team for chat mode
  const { teams } = useTeamContext()

  useEffect(() => {
    const loadModels = async () => {
      setIsLoadingModels(true)
      try {
        const response = await modelApis.getUnifiedModels('Chat', false, 'all', undefined, 'llm')
        const rawModelList = response.data || []

        // Deduplicate models by name (prefer user models over public models)
        const modelMap = new Map<string, UnifiedModel>()
        for (const model of rawModelList) {
          const existing = modelMap.get(model.name)
          // If no existing model or current model is user type (higher priority), use current
          if (!existing || model.type === 'user') {
            modelMap.set(model.name, model)
          }
        }
        const modelList = Array.from(modelMap.values())
        setAvailableModels(modelList)

        if (!selectedModel && modelList.length > 0) {
          // Find default team for chat mode
          const chatDefaultTeam = teams.find(
            team => team.default_for_modes && team.default_for_modes.includes('chat')
          )

          let defaultModelName: string | null = null

          // Try to get bind_model from default team's first bot
          if (chatDefaultTeam?.bots && chatDefaultTeam.bots.length > 0) {
            const firstBot = chatDefaultTeam.bots[0]
            const botConfig = firstBot.bot?.agent_config as Record<string, unknown> | undefined
            if (botConfig) {
              defaultModelName = getModelFromConfig(botConfig)
            }
          }

          // Find the model in the list
          let modelToSelect: UnifiedModel | undefined

          if (defaultModelName) {
            modelToSelect = modelList.find(
              m => m.name === defaultModelName || m.displayName === defaultModelName
            )
          }

          // Fallback to first model if default not found
          if (!modelToSelect) {
            modelToSelect = modelList[0]
          }

          if (modelToSelect) {
            onModelChange({
              model_name: modelToSelect.name,
              model_id: modelToSelect.modelId || undefined,
              reason: '',
              confidence: 1.0,
            })
          }
        }
      } catch (error) {
        console.error('Failed to load models:', error)
      } finally {
        setIsLoadingModels(false)
      }
    }
    loadModels()
  }, [teams]) // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) {
    return <GeneratingLoader />
  }

  const handleTestSubmit = async () => {
    if (!testMessage.trim()) return
    const messageToSend = testMessage
    setTestMessage('')
    await onTestPrompt(messageToSend)
  }

  const handleIterateSubmit = async () => {
    if (!feedbackMessage.trim()) return
    await onIteratePrompt(feedbackMessage)
    setFeedbackMessage('')
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

  const latestConversation =
    testConversations.length > 0 ? testConversations[testConversations.length - 1] : null

  const convertToMessages = (conversation: TestConversation): Message[] => {
    const messages: Message[] = []

    messages.push({
      type: 'user',
      content: conversation.testMessage,
      timestamp: Date.now(),
    })

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

  const paragraphAction: ParagraphAction = {
    icon: <Wand2 className="w-4 h-4" />,
    tooltip: t('wizard:optimize_paragraph'),
    onAction: () => setPromptPopoverOpen(true),
  }

  const hasSkills = availableSkills.length > 0 && onToggleSkill
  const promptCharCount = systemPrompt.length

  // Get selected skill names for display
  const selectedSkillNames = availableSkills
    .filter(skill => selectedSkills.includes(skill.name))
    .map(skill => skill.name)

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-3 flex-shrink-0 flex-wrap">
        {/* Model Selector */}
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-text-secondary" />
          <Select
            value={selectedModel?.model_name || ''}
            onValueChange={handleModelSelect}
            disabled={isLoadingModels}
          >
            <SelectTrigger className="w-[160px] h-9">
              <SelectValue
                placeholder={isLoadingModels ? t('models.loading') : t('wizard:select_model')}
              />
            </SelectTrigger>
            <SelectContent>
              {availableModels.map(model => (
                <SelectItem key={model.name} value={model.name}>
                  {model.displayName || model.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="h-5 w-px bg-border" />

        {/* Prompt Popover - Combined with Iterate */}
        <Popover open={promptPopoverOpen} onOpenChange={setPromptPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={`h-9 gap-2 ${isRefreshing ? 'border-primary text-primary' : ''}`}
            >
              <FileText className="w-4 h-4" />
              <span>{t('wizard:system_prompt')}</span>
              <span className="text-text-muted">({promptCharCount})</span>
              {showRefreshSuccess && <Sparkles className="w-3 h-3 text-primary" />}
              <ChevronDown className="w-3 h-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[520px] p-0" align="start">
            {/* Prompt Section Header */}
            <div className="px-4 py-3 border-b border-border">
              <Label className="text-sm font-medium flex items-center gap-2">
                <FileText className="w-4 h-4 text-text-secondary" />
                {t('wizard:system_prompt')}
                <span className="text-text-muted font-normal">({promptCharCount} chars)</span>
              </Label>
            </div>
            <div
              ref={promptScrollRef}
              className="max-h-[50vh] overflow-y-auto"
              onWheel={e => handleWheel(e, promptScrollRef)}
              style={{ overscrollBehavior: 'contain' }}
            >
              <div className="p-4 border-b border-border">
                <div className="border border-border rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-primary focus-within:border-primary">
                  <Textarea
                    value={systemPrompt}
                    onChange={e => onPromptChange(e.target.value)}
                    className="min-h-[180px] max-h-[240px] font-mono text-sm resize-none w-full border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                    placeholder={t('wizard:system_prompt_placeholder')}
                    onWheel={e => e.stopPropagation()}
                  />
                </div>
              </div>
              {/* Iterate Section */}
              <div className="px-4 py-3 border-b border-border bg-muted/30">
                <Label className="text-sm font-medium flex items-center gap-2">
                  <Wand2 className="w-4 h-4 text-primary" />
                  {t('wizard:iterate_label')}
                </Label>
                <p className="text-xs text-text-muted mt-1">
                  {t('wizard:preview_adjust_iterate_hint')}
                </p>
              </div>
              <div className="px-4 py-3">
                <Textarea
                  value={feedbackMessage}
                  onChange={e => setFeedbackMessage(e.target.value)}
                  placeholder={t('wizard:iterate_placeholder')}
                  className="min-h-[60px] max-h-[100px] text-sm resize-none mb-3"
                  onWheel={e => e.stopPropagation()}
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
                    disabled={isIteratingPrompt || !feedbackMessage.trim()}
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
          </PopoverContent>
        </Popover>

        {/* Skills Popover */}
        {hasSkills && (
          <Popover open={skillsPopoverOpen} onOpenChange={setSkillsPopoverOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 gap-2">
                <Zap className="w-4 h-4 text-primary" />
                <span>{t('wizard:skills_section')}</span>
                {selectedSkills.length > 0 ? (
                  <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded text-xs">
                    {selectedSkills.length}
                  </span>
                ) : (
                  <span className="text-text-muted">(0)</span>
                )}
                <ChevronDown className="w-3 h-3" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[440px] p-0" align="start">
              <div className="px-4 py-3 border-b border-border">
                <Label className="text-sm font-medium flex items-center gap-2">
                  <Zap className="w-4 h-4 text-primary" />
                  {t('wizard:skills_section')}
                </Label>
                <p className="text-xs text-text-muted mt-1">{t('wizard:skills_hint')}</p>
              </div>
              <div
                ref={skillsScrollRef}
                className="max-h-[350px] overflow-y-auto"
                onWheel={e => handleWheel(e, skillsScrollRef)}
                style={{ overscrollBehavior: 'contain' }}
              >
                <div className="p-4">
                  <SkillSelector
                    availableSkills={availableSkills}
                    recommendedSkills={recommendedSkills}
                    selectedSkills={selectedSkills}
                    onToggleSkill={onToggleSkill}
                  />
                </div>
              </div>
            </PopoverContent>
          </Popover>
        )}

        {/* Selected Skills Tags */}
        {selectedSkillNames.length > 0 && (
          <>
            <div className="h-5 w-px bg-border" />
            <div className="flex items-center gap-1.5 flex-wrap">
              {selectedSkillNames.slice(0, 3).map(name => (
                <span
                  key={name}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/10 text-primary text-xs rounded"
                >
                  <Zap className="w-3 h-3" />
                  {name}
                </span>
              ))}
              {selectedSkillNames.length > 3 && (
                <span className="text-xs text-text-muted">+{selectedSkillNames.length - 3}</span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Chat Preview - Main Area */}
      <div
        className={`flex-1 border rounded-lg bg-surface overflow-hidden flex flex-col min-h-0 transition-all duration-300 ${isRefreshing ? 'border-primary' : 'border-border'}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30 flex-shrink-0">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-text-secondary" />
            <span className="text-sm font-medium">{t('wizard:single_round_preview')}</span>
          </div>
          <span className="text-xs text-text-muted">{t('wizard:single_round_hint')}</span>
        </div>

        {/* Messages */}
        <div
          ref={messagesAreaRef}
          className={`flex-1 p-4 min-h-0 ${latestConversation ? 'overflow-y-auto' : 'overflow-hidden'}`}
        >
          {!latestConversation ? (
            <div className="flex flex-col items-center justify-center h-full text-text-muted">
              <MessageSquare className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm">{t('wizard:test_empty')}</p>
              <p className="text-xs mt-1 text-text-muted">
                {t('wizard:preview_adjust_empty_hint')}
              </p>
            </div>
          ) : (
            <div className={`space-y-4 ${isFadingOut ? 'messages-fade-out' : ''}`}>
              {convertToMessages(latestConversation).map((msg, index) => (
                <MessageBubble
                  key={`${msg.type}-${index}`}
                  msg={msg}
                  index={index}
                  selectedTaskDetail={null}
                  theme={theme}
                  t={t}
                  isWaiting={msg.isWaiting}
                  paragraphAction={
                    msg.type === 'ai' && msg.content && !msg.isWaiting ? paragraphAction : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-border p-3 bg-base flex-shrink-0">
          <div className="flex gap-2">
            <Textarea
              value={testMessage}
              onChange={e => setTestMessage(e.target.value)}
              placeholder={t('wizard:preview_adjust_input_placeholder')}
              className="min-h-[44px] max-h-[80px] flex-1 text-sm resize-none"
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
              className="self-end h-11 px-4"
            >
              {isTestingPrompt ? <Spinner className="w-4 h-4" /> : t('wizard:click_to_test')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
