// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ReactNode, useId } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Button } from '@/components/ui/button'
import { ChevronDown, Plus, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  KnowledgeResourceScope,
  RetrievalConfigDraft,
  SummaryModelRef,
} from '@/types/knowledge'
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
  /** Optional bind model name from team's bot config as fallback */
  bindModel?: string | null
  callLimits: {
    maxCalls: number
    exemptCalls: number
  }
  onCallLimitsChange: (limits: { maxCalls: number; exemptCalls: number }) => void
  advancedOpen: boolean
  onAdvancedOpenChange: (open: boolean) => void
  retrievalModeSection?: ReactNode
  showRetrievalSection: boolean
  retrievalConfig: RetrievalConfigDraft
  onRetrievalConfigChange: (config: RetrievalConfigDraft) => void
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

function FormSection({
  title,
  sectionId,
  open,
  onOpenChange,
  children,
}: {
  title: string
  sectionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  const contentId = useId()

  return (
    <section className="space-y-4">
      <button
        type="button"
        aria-controls={contentId}
        aria-expanded={open}
        data-testid={`${sectionId}-section-trigger`}
        onClick={() => onOpenChange(!open)}
        className="group flex w-full items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <h3 className="shrink-0 text-sm font-semibold text-text-primary">{title}</h3>
        <div className="h-px flex-1 bg-border transition-colors group-hover:bg-primary/40" />
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-text-muted transition-transform duration-200',
            !open && '-rotate-90'
          )}
        />
      </button>
      {open && (
        <div id={contentId} className="space-y-5">
          {children}
        </div>
      )}
    </section>
  )
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
  bindModel,
  callLimits,
  onCallLimitsChange,
  advancedOpen,
  onAdvancedOpenChange,
  retrievalModeSection,
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
    <div className="space-y-5">
      <div className="space-y-3">
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

      {(retrievalModeSection || showRetrievalSection) && (
        <div className="space-y-3">
          <div className="space-y-0.5">
            <Label className="text-sm font-medium">
              {t('knowledge:document.ragConfigMode.title')}
            </Label>
          </div>

          {retrievalModeSection}

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

      <div className="space-y-3">
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
              bindModel={bindModel}
            />
          </div>
        )}
      </div>

      {showGuidedQuestions && (
        <div className="space-y-3">
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

      <FormSection
        title={t('knowledge:document.advancedSettings.title')}
        sectionId="knowledge-advanced"
        open={advancedOpen}
        onOpenChange={onAdvancedOpenChange}
      >
        {advancedContent}
      </FormSection>
    </div>
  )
}
