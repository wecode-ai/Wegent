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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { ChevronDown, ChevronRight } from 'lucide-react'
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
}: KnowledgeBaseFormProps) {
  const { t } = useTranslation()

  const handleMaxCallsChange = (value: number) => {
    const adjustedExempt = Math.min(callLimits.exemptCalls, Math.max(value - 1, 1))
    onCallLimitsChange({ maxCalls: value, exemptCalls: adjustedExempt })
  }

  const handleExemptCallsChange = (value: number) => {
    onCallLimitsChange({ maxCalls: callLimits.maxCalls, exemptCalls: value })
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
