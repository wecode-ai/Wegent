// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useRef, useEffect, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import {
  GroupedModelSelect,
  type ModelCascadeLabels,
} from '@/components/model-select/ModelCascadeSelect'
import { useTranslation } from '@/hooks/useTranslation'
import { MessageSquare, Send, Wand2, RefreshCw, Cpu } from 'lucide-react'
import { modelApis, type UnifiedModel } from '@/apis/models'
import { MessageBubble, type Message } from '@/features/tasks/components/message'
import { useTheme } from '@/features/theme/ThemeProvider'

interface PromptTestPanelProps {
  systemPrompt: string
  testMessage: string
  setTestMessage: (message: string) => void
  aiResponse: string
  isTestingPrompt: boolean
  isIteratingPrompt: boolean
  userFeedback: string
  setUserFeedback: (feedback: string) => void
  selectedModel: string
  onModelChange: (model: string) => void
  onTestPrompt: () => Promise<void>
  onIteratePrompt: () => Promise<void>
  hideIterateSection?: boolean
}

export default function PromptTestPanel({
  testMessage,
  setTestMessage,
  aiResponse,
  isTestingPrompt,
  isIteratingPrompt,
  userFeedback,
  setUserFeedback,
  selectedModel,
  onModelChange,
  onTestPrompt,
  onIteratePrompt,
  hideIterateSection = false,
}: PromptTestPanelProps) {
  const { t } = useTranslation('wizard')
  const { theme } = useTheme()
  const [availableModels, setAvailableModels] = useState<UnifiedModel[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

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
          onModelChange(response.data[0].name)
        }
      } catch (error) {
        console.error('Failed to load models:', error)
      } finally {
        setIsLoadingModels(false)
      }
    }
    loadModels()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to bottom when AI response updates
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [aiResponse])

  const handleTestSubmit = async () => {
    if (!testMessage.trim() || isTestingPrompt) return
    await onTestPrompt()
  }

  const handleIterateSubmit = async () => {
    if (!userFeedback.trim() || isIteratingPrompt) return
    await onIteratePrompt()
  }

  // Convert conversation to Message format for MessageBubble
  const getMessages = (): Message[] => {
    const messages: Message[] = []

    if (testMessage) {
      messages.push({
        type: 'user',
        content: testMessage,
        timestamp: Date.now(),
      })
    }

    if (aiResponse || isTestingPrompt) {
      messages.push({
        type: 'ai',
        content: aiResponse || '',
        timestamp: Date.now(),
        botName: selectedModel || 'AI',
        isWaiting: isTestingPrompt && !aiResponse,
      })
    }

    return messages
  }

  const messages = getMessages()
  const selectedModelOption = useMemo(
    () => availableModels.find(model => model.name === selectedModel) ?? null,
    [availableModels, selectedModel]
  )
  const cascadeLabels: ModelCascadeLabels = useMemo(
    () => ({
      ungrouped: t('common:models.ungrouped', 'Ungrouped'),
      uncategorized: t('common:models.uncategorized', 'Uncategorized'),
      searchPlaceholder: t('common:models.search_models', 'Search models or groups...'),
      searchResults: t('common:models.search_results', 'Search results'),
      noModels: t('common:models.no_models', 'No models available'),
      noMatch: t('common:models.no_match', 'No matching models'),
      primaryGroups: t('common:models.primary_groups', 'Primary groups'),
      secondaryGroups: t('common:models.secondary_groups', 'Secondary groups'),
    }),
    [t]
  )

  return (
    <div className="h-full flex flex-col">
      {/* Model selector */}
      <div className="flex items-center gap-3 p-3 border-b border-border flex-shrink-0">
        <Cpu className="w-4 h-4 text-text-secondary" />
        <span className="text-sm font-medium text-text-primary">{t('wizard:select_model')}</span>
        <GroupedModelSelect
          models={availableModels}
          selectedModel={selectedModelOption}
          labels={cascadeLabels}
          onSelectModel={model => onModelChange(model.name)}
          placeholder={isLoadingModels ? t('common:models.loading') : t('wizard:select_model')}
          disabled={isLoadingModels}
          dataTestId="prompt-test-model-select"
          triggerClassName="w-[220px]"
          getModelKey={model => `${model.type}-${model.namespace}-${model.name}`}
          renderModelBadges={model =>
            model.type === 'public' ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-text-muted">
                {t('common:models.public')}
              </span>
            ) : null
          }
        />
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4 min-h-0">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-muted">
            <MessageSquare className="w-10 h-10 mb-3 opacity-50" />
            <p className="text-sm">{t('wizard:test_empty')}</p>
            <p className="text-xs mt-1">{t('wizard:preview_adjust_empty_hint')}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg, index) => (
              <MessageBubble
                key={`${msg.type}-${index}`}
                msg={msg}
                index={index}
                selectedTaskDetail={null}
                theme={theme}
                t={t}
                isWaiting={msg.isWaiting}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Test input area */}
      <div className="border-t border-border p-3 space-y-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium text-text-primary">
            {t('wizard:test_input_label')}
          </span>
        </div>
        <div className="flex gap-2">
          <Textarea
            value={testMessage}
            onChange={e => setTestMessage(e.target.value)}
            placeholder={t('wizard:preview_adjust_input_placeholder')}
            className="min-h-[60px] flex-1 text-sm resize-none"
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
            className="self-end"
          >
            {isTestingPrompt ? <Spinner className="w-4 h-4" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>

        {/* Iterate section - only show when we have a response and not hidden */}
        {aiResponse && !hideIterateSection && (
          <div className="space-y-2 pt-2 border-t border-border">
            <div className="flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium text-text-primary">
                {t('wizard:iterate_label')}
              </span>
            </div>
            <p className="text-xs text-text-muted">{t('wizard:preview_adjust_iterate_hint')}</p>
            <Textarea
              value={userFeedback}
              onChange={e => setUserFeedback(e.target.value)}
              placeholder={t('wizard:iterate_placeholder')}
              className="min-h-[60px] text-sm resize-none"
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
                disabled={isIteratingPrompt || !userFeedback.trim()}
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
        )}
      </div>
    </div>
  )
}
