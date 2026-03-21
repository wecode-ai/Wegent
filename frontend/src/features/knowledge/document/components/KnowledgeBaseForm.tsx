// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ReactNode } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Button } from '@/components/ui/button'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeResourceScope, RetrievalConfig, SummaryModelRef } from '@/types/knowledge'
import { RetrievalSettingsSection } from './RetrievalSettingsSection'
import { SummaryModelSelector } from './SummaryModelSelector'

interface KnowledgeBaseFormProps {
  typeSection?: ReactNode
  name: string
  description: string
  onNameChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  summaryEnabled: boolean
  onSummaryEnabledChange: (value: boolean) => void
  summaryModelRef: SummaryModelRef | null
  summaryModelError?: string
  onSummaryModelChange: (value: SummaryModelRef | null) => void
  knowledgeDefaultTeamId?: number | null
  callLimits: {
    maxCalls: number
    exemptCalls: number
  }
  onCallLimitsChange: (limits: { maxCalls: number; exemptCalls: number }) => void
  advancedVariant: 'accordion' | 'collapsible'
  advancedOpen: boolean
  onAdvancedOpenChange: (open: boolean) => void
  advancedDescription?: string
  showRetrievalSection: boolean
  retrievalConfig: Partial<RetrievalConfig>
  onRetrievalConfigChange: (config: Partial<RetrievalConfig>) => void
  retrievalScope?: KnowledgeResourceScope
  retrievalGroupName?: string
  retrievalReadOnly?: boolean
  retrievalPartialReadOnly?: boolean
  /** Whether to show guided questions section (only for notebook type) */
  showGuidedQuestions?: boolean
  /** Guided questions list (max 3) */
  guidedQuestions?: string[]
  /** Handler for guided questions change */
  onGuidedQuestionsChange?: (questions: string[]) => void
}

export function KnowledgeBaseForm({
  typeSection,
  name,
  description,
  onNameChange,
  onDescriptionChange,
  summaryEnabled,
  onSummaryEnabledChange,
  summaryModelRef,
  summaryModelError,
  onSummaryModelChange,
  knowledgeDefaultTeamId,
  callLimits,
  onCallLimitsChange,
  advancedVariant,
  advancedOpen,
  onAdvancedOpenChange,
  advancedDescription,
  showRetrievalSection,
  retrievalConfig,
  onRetrievalConfigChange,
  retrievalScope,
  retrievalGroupName,
  retrievalReadOnly,
  retrievalPartialReadOnly,
  showGuidedQuestions = false,
  guidedQuestions = [],
  onGuidedQuestionsChange,
}: KnowledgeBaseFormProps) {
  const { t } = useTranslation()

  const handleMaxCallsChange = (value: number) => {
    const adjustedExempt = Math.min(callLimits.exemptCalls, Math.max(value - 1, 1))
    onCallLimitsChange({ maxCalls: value, exemptCalls: adjustedExempt })
  }

  const handleExemptCallsChange = (value: number) => {
    onCallLimitsChange({ maxCalls: callLimits.maxCalls, exemptCalls: value })
  }

  // Guided questions handlers
  const MAX_GUIDED_QUESTIONS = 3
  const MAX_QUESTION_LENGTH = 200

  const handleAddGuidedQuestion = () => {
    if (guidedQuestions.length < MAX_GUIDED_QUESTIONS && onGuidedQuestionsChange) {
      onGuidedQuestionsChange([...guidedQuestions, ''])
    }
  }

  const handleUpdateGuidedQuestion = (index: number, value: string) => {
    if (onGuidedQuestionsChange) {
      const newQuestions = [...guidedQuestions]
      newQuestions[index] = value.slice(0, MAX_QUESTION_LENGTH)
      onGuidedQuestionsChange(newQuestions)
    }
  }

  const handleRemoveGuidedQuestion = (index: number) => {
    if (onGuidedQuestionsChange) {
      const newQuestions = guidedQuestions.filter((_, i) => i !== index)
      onGuidedQuestionsChange(newQuestions)
    }
  }

  const advancedContent = (
    <div className="space-y-4 pt-2">
      {advancedDescription && <p className="text-xs text-text-muted">{advancedDescription}</p>}

      <div className="space-y-4">
        <div className="space-y-0.5">
          <Label className="text-sm font-medium">{t('knowledge:document.callLimits.title')}</Label>
          <p className="text-xs text-text-muted">
            {t('knowledge:document.callLimits.description')}
          </p>
        </div>
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="knowledge-max-calls">
                {t('knowledge:document.callLimits.maxCalls')}
              </Label>
              <span className="text-sm text-text-secondary">{callLimits.maxCalls}</span>
            </div>
            <Slider
              id="knowledge-max-calls"
              value={[callLimits.maxCalls]}
              onValueChange={values => handleMaxCallsChange(values[0])}
              min={2}
              max={50}
              step={1}
            />
            <p className="text-xs text-text-muted">
              {t('knowledge:document.callLimits.maxCallsHint')}
            </p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="knowledge-exempt-calls">
                {t('knowledge:document.callLimits.exemptCalls')}
              </Label>
              <span className="text-sm text-text-secondary">{callLimits.exemptCalls}</span>
            </div>
            <Slider
              id="knowledge-exempt-calls"
              value={[callLimits.exemptCalls]}
              onValueChange={values => handleExemptCallsChange(values[0])}
              min={1}
              max={Math.max(1, callLimits.maxCalls - 1)}
              step={1}
            />
            <p className="text-xs text-text-muted">
              {t('knowledge:document.callLimits.exemptCallsHint')}
            </p>
          </div>
        </div>
      </div>

      {showRetrievalSection && (
        <RetrievalSettingsSection
          config={retrievalConfig}
          onChange={onRetrievalConfigChange}
          scope={retrievalScope}
          groupName={retrievalGroupName}
          readOnly={retrievalReadOnly}
          partialReadOnly={retrievalPartialReadOnly}
        />
      )}
    </div>
  )

  return (
    <div className="space-y-4">
      {typeSection}

      <div className="space-y-2">
        <Label htmlFor="knowledge-name">{t('knowledge:document.knowledgeBase.name')}</Label>
        <Input
          id="knowledge-name"
          value={name}
          onChange={e => onNameChange(e.target.value)}
          placeholder={t('knowledge:document.knowledgeBase.namePlaceholder')}
          maxLength={100}
          data-testid="kb-name-input"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="knowledge-description">
          {t('knowledge:document.knowledgeBase.description')}
        </Label>
        <Textarea
          id="knowledge-description"
          value={description}
          onChange={e => onDescriptionChange(e.target.value)}
          placeholder={t('knowledge:document.knowledgeBase.descriptionPlaceholder')}
          maxLength={500}
          rows={3}
          data-testid="kb-description-input"
        />
      </div>

      <div className="space-y-3 border-b border-border pb-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="knowledge-summary-enabled">
              {t('knowledge:document.summary.enableLabel')}
            </Label>
            <p className="text-xs text-text-muted">
              {t('knowledge:document.summary.enableDescription')}
            </p>
          </div>
          <Switch
            id="knowledge-summary-enabled"
            checked={summaryEnabled}
            onCheckedChange={checked => onSummaryEnabledChange(checked)}
          />
        </div>
        {summaryEnabled && (
          <div className="space-y-2 pt-2">
            <Label>{t('knowledge:document.summary.selectModel')}</Label>
            <SummaryModelSelector
              value={summaryModelRef}
              onChange={onSummaryModelChange}
              error={summaryModelError}
              knowledgeDefaultTeamId={knowledgeDefaultTeamId}
            />
          </div>
        )}
      </div>

      {showGuidedQuestions && (
        <div className="space-y-3 border-b border-border pb-4">
          <div className="space-y-0.5">
            <Label>{t('knowledge:document.guidedQuestions.label')}</Label>
            <p className="text-xs text-text-muted">
              {t('knowledge:document.guidedQuestions.helpText')}
            </p>
          </div>
          <div className="space-y-2">
            {guidedQuestions.map((question, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  value={question}
                  onChange={e => handleUpdateGuidedQuestion(index, e.target.value)}
                  placeholder={t('knowledge:document.guidedQuestions.placeholder')}
                  maxLength={MAX_QUESTION_LENGTH}
                  data-testid={`guided-question-input-${index}`}
                  aria-label={`${t('knowledge:document.guidedQuestions.label')} ${index + 1}`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => handleRemoveGuidedQuestion(index)}
                  className="h-9 w-9 flex-shrink-0"
                  data-testid={`remove-guided-question-${index}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {guidedQuestions.length < MAX_GUIDED_QUESTIONS && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddGuidedQuestion}
                className="mt-2"
                data-testid="add-guided-question"
              >
                <Plus className="h-4 w-4 mr-1" />
                {t('knowledge:document.guidedQuestions.addButton')}
              </Button>
            )}
            {guidedQuestions.length >= MAX_GUIDED_QUESTIONS && (
              <p className="text-xs text-text-muted">
                {t('knowledge:document.guidedQuestions.maxReached')}
              </p>
            )}
          </div>
        </div>
      )}

      {advancedVariant === 'accordion' ? (
        <Accordion
          type="single"
          collapsible
          className="border-none"
          value={advancedOpen ? 'advanced' : undefined}
          onValueChange={value => onAdvancedOpenChange(value === 'advanced')}
        >
          <AccordionItem value="advanced" className="border-none">
            <AccordionTrigger className="text-sm font-medium hover:no-underline">
              {t('knowledge:document.advancedSettings.title')}
            </AccordionTrigger>
            <AccordionContent forceMount className={!advancedOpen ? 'hidden' : ''}>
              {advancedContent}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      ) : (
        <div className="pt-2">
          <button
            type="button"
            onClick={() => onAdvancedOpenChange(!advancedOpen)}
            className="flex items-center gap-2 text-sm font-medium text-text-primary hover:text-primary transition-colors"
          >
            {advancedOpen ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
            {t('knowledge:document.advancedSettings.title')}
          </button>
          {advancedOpen && (
            <div className="mt-4 p-4 bg-bg-muted rounded-lg border border-border space-y-6">
              {advancedContent}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
