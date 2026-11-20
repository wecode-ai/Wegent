// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { type ReactNode, useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Slider } from '@/components/ui/slider'
import { Button } from '@/components/ui/button'
import { Plus, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import {
  SimpleConfigGroup,
  SimpleConfigRow,
} from '@/features/settings/components/team-edit/SimpleConfigLayout'
import type {
  DirectAccessRequirement,
  KnowledgeResourceScope,
  RetrievalConfigDraft,
  SummaryModelRef,
} from '@/types/knowledge'
import { RetrievalSettingsSection } from './RetrievalSettingsSection'
import { ModelRefSelector } from '@/components/model-select/ModelRefSelector'
import { MultimodalConfigSection } from '@/features/knowledge/multimodal/components/MultimodalConfigSection'
import { useMultimodalFeatureEnabled } from '@/features/knowledge/multimodal/hooks/useMultimodalFeatureEnabled'

interface KnowledgeBaseFormProps {
  navigation: ReturnType<typeof useKnowledgeBaseFormNavigation>
  kindSection?: ReactNode
  locationSection?: ReactNode
  typeSection?: ReactNode
  /** False for a code wiki: left blank, the repository's own name is used. */
  nameRequired?: boolean
  /** Overrides the placeholder, to say what a blank name will be filled in with. */
  namePlaceholder?: string
  name: string
  description: string
  onNameChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  directAccessRequirement?: DirectAccessRequirement
  onDirectAccessRequirementChange?: (value: DirectAccessRequirement) => void
  allowDocumentDownload?: boolean
  onAllowDocumentDownloadChange?: (value: boolean) => void
  summaryEnabled: boolean
  onSummaryEnabledChange: (value: boolean) => void
  summaryModelRef: SummaryModelRef | null
  summaryModelError?: string
  onSummaryModelChange: (value: SummaryModelRef | null) => void
  multimodalAnalysisEnabled: boolean
  onMultimodalAnalysisEnabledChange: (value: boolean) => void
  multimodalAnalysisModelRef: SummaryModelRef | null
  multimodalAnalysisModelError?: string
  onMultimodalAnalysisModelChange: (value: SummaryModelRef | null) => void
  multimodalAnalysisVideoPrompt?: string | null
  multimodalAnalysisImagePrompt?: string | null
  onMultimodalVideoPromptChange?: (value: string | null) => void
  onMultimodalImagePromptChange?: (value: string | null) => void
  knowledgeDefaultTeamId?: number | null
  /** Optional bind model name from team's bot config as fallback */
  bindModel?: string | null
  callLimits: {
    maxCalls: number
    exemptCalls: number
  }
  onCallLimitsChange: (limits: { maxCalls: number; exemptCalls: number }) => void
  generationSection?: ReactNode
  documentSyncSetting?: ReactNode
  retrievalModeSection?: ReactNode
  showRetrievalSection: boolean
  retrievalConfig: RetrievalConfigDraft
  onRetrievalConfigChange: (config: RetrievalConfigDraft) => void
  onRetrievalConfigUserChange?: () => void
  retrievalScopeKey?: string
  retrievalScope?: KnowledgeResourceScope
  retrievalGroupName?: string
  retrievalReadOnly?: boolean
  retrievalPartialReadOnly?: boolean
  /** Whether to show Notebook guided questions configuration */
  showGuidedQuestions?: boolean
  /** Guided questions list (max 3) */
  guidedQuestions?: string[]
  /** Handler for guided questions change */
  onGuidedQuestionsChange?: (questions: string[]) => void
}

const sections = [
  ['basic', 'knowledge-basic', 'basic'],
  ['access', 'knowledge-access', 'accessAndDownload'],
  ['models', 'knowledge-summary', 'summaryAndMultimodal'],
  ['retrieval', 'knowledge-advanced', 'retrieval'],
  ['usage', 'knowledge-guided-questions', 'guidanceAndLimits'],
  ['generation', 'knowledge-generation', 'generationAndSchedule'],
] as const

type Section = (typeof sections)[number][0]

export function useKnowledgeBaseFormNavigation() {
  const [selection, setSelection] = useState<{ section: Section; focus?: string }>({
    section: 'basic',
  })

  const selectSection = useCallback((section: Section, focus?: string) => {
    setSelection({ section, focus })
  }, [])

  return { selection, selectSection }
}

export function KnowledgeBaseForm({
  navigation,
  kindSection,
  locationSection,
  typeSection,
  nameRequired = true,
  namePlaceholder,
  name,
  description,
  onNameChange,
  onDescriptionChange,
  directAccessRequirement,
  onDirectAccessRequirementChange,
  allowDocumentDownload = true,
  onAllowDocumentDownloadChange = () => {},
  summaryEnabled,
  onSummaryEnabledChange,
  summaryModelRef,
  summaryModelError,
  onSummaryModelChange,
  multimodalAnalysisEnabled,
  onMultimodalAnalysisEnabledChange,
  multimodalAnalysisModelRef,
  multimodalAnalysisModelError,
  onMultimodalAnalysisModelChange,
  multimodalAnalysisVideoPrompt,
  multimodalAnalysisImagePrompt,
  onMultimodalVideoPromptChange,
  onMultimodalImagePromptChange,
  knowledgeDefaultTeamId,
  bindModel,
  callLimits,
  onCallLimitsChange,
  generationSection,
  documentSyncSetting,
  retrievalModeSection,
  showRetrievalSection,
  retrievalConfig,
  onRetrievalConfigChange,
  onRetrievalConfigUserChange,
  retrievalScopeKey,
  retrievalScope,
  retrievalGroupName,
  retrievalReadOnly,
  retrievalPartialReadOnly,
  showGuidedQuestions = false,
  guidedQuestions = [],
  onGuidedQuestionsChange,
}: KnowledgeBaseFormProps) {
  const { t } = useTranslation('knowledge')
  const { selection, selectSection } = navigation
  const panelId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const sidebar = useRef<HTMLElement>(null)
  const [modelsOpened, setModelsOpened] = useState(false)
  const [retrievalOpened, setRetrievalOpened] = useState(false)

  useLayoutEffect(() => {
    if (selection.section === 'models') setModelsOpened(true)
    const content = panel.current
    if (!content) return
    content.scrollTop = 0
    const selector = selection.focus
    if (!selector) return

    sidebar.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({
      block: 'nearest',
      inline: 'nearest',
    })
    const focusField = () => {
      const target = content.querySelector<HTMLElement>(selector)
      target?.focus()
      return target != null && document.activeElement === target
    }
    if (focusField()) return
    content.focus()

    // Model controls can be disabled while their options are loading.
    const observer = new MutationObserver(() => {
      if (document.activeElement !== content || focusField()) observer.disconnect()
    })
    observer.observe(content, {
      attributes: true,
      attributeFilter: ['disabled', 'aria-disabled', 'aria-busy'],
      childList: true,
      subtree: true,
    })
    return () => observer.disconnect()
  }, [selection])

  // Hide the entire multimodal section when the global pipeline switch is off.
  const multimodalFeatureEnabled = useMultimodalFeatureEnabled()

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

  const content: Record<Section, ReactNode> = {
    basic: (
      <>
        {kindSection}

        <SimpleConfigRow
          label={
            <>
              {t('document.knowledgeBase.name')}
              {nameRequired && <span className="text-red-400"> *</span>}
            </>
          }
        >
          <Input
            id="knowledge-name"
            value={name}
            onChange={e => onNameChange(e.target.value)}
            placeholder={namePlaceholder ?? t('document.knowledgeBase.namePlaceholder')}
            maxLength={100}
            data-testid="kb-name-input"
            className="bg-base"
          />
        </SimpleConfigRow>

        <SimpleConfigRow label={t('document.knowledgeBase.description')} align="start">
          <Textarea
            id="knowledge-description"
            value={description}
            onChange={e => onDescriptionChange(e.target.value)}
            placeholder={t('document.knowledgeBase.descriptionPlaceholder')}
            maxLength={500}
            rows={3}
            data-testid="kb-description-input"
            className="bg-base"
          />
        </SimpleConfigRow>
        {locationSection}
        {typeSection}
      </>
    ),
    access: directAccessRequirement && onDirectAccessRequirementChange && (
      <>
        <SimpleConfigRow
          label={t('document.knowledgeBase.allowDocumentDownload')}
          description={t('document.knowledgeBase.allowDocumentDownloadDescription')}
        >
          <div className="flex justify-end">
            <Switch
              id="knowledge-base-allow-document-download"
              checked={allowDocumentDownload ?? true}
              onCheckedChange={onAllowDocumentDownloadChange}
              data-testid="knowledge-base-allow-document-download"
            />
          </div>
        </SimpleConfigRow>
        <SimpleConfigRow
          label={t('document.knowledgeBase.directAccessRange')}
          description={t('document.knowledgeBase.directAccessRangeDescription')}
          align="start"
        >
          <RadioGroup
            value={directAccessRequirement}
            onValueChange={value =>
              onDirectAccessRequirementChange(value as DirectAccessRequirement)
            }
            className="space-y-2"
            data-testid="knowledge-base-direct-access-requirement"
          >
            <div className="flex items-start gap-3 rounded-lg border border-border p-3 hover:bg-surface/50">
              <RadioGroupItem
                value="read"
                id="knowledge-direct-access-read"
                data-testid="knowledge-base-direct-access-read"
                className="mt-0.5"
              />
              <Label htmlFor="knowledge-direct-access-read" className="flex-1 cursor-pointer">
                <span className="block text-sm font-medium text-text-primary">
                  {t('document.knowledgeBase.directAccessAllMembers')}
                </span>
                <span className="mt-1 block text-xs font-normal leading-5 text-text-muted">
                  {t('document.knowledgeBase.directAccessAllMembersDescription')}
                </span>
              </Label>
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-border p-3 hover:bg-surface/50">
              <RadioGroupItem
                value="edit"
                id="knowledge-direct-access-edit"
                data-testid="knowledge-base-direct-access-edit"
                className="mt-0.5"
              />
              <Label htmlFor="knowledge-direct-access-edit" className="flex-1 cursor-pointer">
                <span className="block text-sm font-medium text-text-primary">
                  {t('document.knowledgeBase.directAccessEditorsOnly')}
                </span>
                <span className="mt-1 block text-xs font-normal leading-5 text-text-muted">
                  {t('document.knowledgeBase.directAccessEditorsOnlyDescription')}
                </span>
              </Label>
            </div>
          </RadioGroup>
        </SimpleConfigRow>
      </>
    ),
    models: (
      <>
        <SimpleConfigRow
          label={t('document.summary.enableLabel')}
          description={t('document.summary.enableDescription')}
        >
          <div className="flex justify-end">
            <Switch
              id="knowledge-summary-enabled"
              checked={summaryEnabled}
              onCheckedChange={checked => onSummaryEnabledChange(checked)}
            />
          </div>
        </SimpleConfigRow>

        {summaryEnabled && (
          <SimpleConfigRow label={t('document.summary.selectModel')}>
            <ModelRefSelector
              value={summaryModelRef}
              onChange={onSummaryModelChange}
              error={summaryModelError}
              placeholder={t('document.summary.selectModel')}
              knowledgeDefaultTeamId={knowledgeDefaultTeamId}
              bindModel={bindModel}
              preferenceScope="summary"
              dataTestId="summary-model-select"
            />
          </SimpleConfigRow>
        )}

        {(modelsOpened || selection.section === 'models') && multimodalFeatureEnabled && (
          <MultimodalConfigSection
            enabled={multimodalAnalysisEnabled}
            modelRef={multimodalAnalysisModelRef}
            modelError={multimodalAnalysisModelError}
            videoPrompt={multimodalAnalysisVideoPrompt}
            imagePrompt={multimodalAnalysisImagePrompt}
            onEnabledChange={onMultimodalAnalysisEnabledChange}
            onModelChange={onMultimodalAnalysisModelChange}
            onVideoPromptChange={onMultimodalVideoPromptChange}
            onImagePromptChange={onMultimodalImagePromptChange}
          />
        )}
      </>
    ),
    retrieval: (
      <>
        {(retrievalModeSection || showRetrievalSection) && (
          <SimpleConfigRow label={t('document.ragConfigMode.title')} align="start">
            <div className="space-y-4">
              {retrievalModeSection}

              {showRetrievalSection && (
                <RetrievalSettingsSection
                  key={retrievalScopeKey}
                  config={retrievalConfig}
                  onChange={onRetrievalConfigChange}
                  onUserChange={onRetrievalConfigUserChange}
                  scope={retrievalScope}
                  groupName={retrievalGroupName}
                  readOnly={retrievalReadOnly}
                  partialReadOnly={retrievalPartialReadOnly}
                />
              )}
            </div>
          </SimpleConfigRow>
        )}
        {documentSyncSetting}
      </>
    ),
    usage: (
      <>
        {showGuidedQuestions && (
          <>
            <SimpleConfigRow
              label={t('document.guidedQuestions.label')}
              description={t('document.guidedQuestions.helpText')}
              align="start"
            >
              <div className="space-y-2">
                {guidedQuestions.map((question, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      value={question}
                      onChange={e => handleUpdateGuidedQuestion(index, e.target.value)}
                      placeholder={t('document.guidedQuestions.placeholder')}
                      maxLength={MAX_QUESTION_LENGTH}
                      data-testid={`guided-question-input-${index}`}
                      aria-label={`${t('document.guidedQuestions.label')} ${index + 1}`}
                      className="bg-base"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemoveGuidedQuestion(index)}
                      className="h-11 w-11 flex-shrink-0"
                      data-testid={`remove-guided-question-${index}`}
                    >
                      <X className="h-5 w-5" />
                    </Button>
                  </div>
                ))}
                {guidedQuestions.length < MAX_GUIDED_QUESTIONS && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleAddGuidedQuestion}
                    data-testid="add-guided-question"
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    {t('document.guidedQuestions.addButton')}
                  </Button>
                )}
                {guidedQuestions.length >= MAX_GUIDED_QUESTIONS && (
                  <p className="text-xs text-text-muted">
                    {t('document.guidedQuestions.maxReached')}
                  </p>
                )}
              </div>
            </SimpleConfigRow>
          </>
        )}
        <SimpleConfigRow
          label={t('document.callLimits.title')}
          description={t('document.callLimits.description')}
          align="start"
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="knowledge-max-calls">{t('document.callLimits.maxCalls')}</Label>
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
              <p className="text-xs text-text-muted">{t('document.callLimits.maxCallsHint')}</p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="knowledge-exempt-calls">
                  {t('document.callLimits.exemptCalls')}
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
              <p className="text-xs text-text-muted">{t('document.callLimits.exemptCallsHint')}</p>
            </div>
          </div>
        </SimpleConfigRow>
      </>
    ),
    generation: generationSection,
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row md:gap-4">
      <nav
        ref={sidebar}
        aria-label={t('document.formSections.navigation')}
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border pb-2 md:w-44 md:flex-col md:overflow-x-hidden md:overflow-y-auto md:border-b-0 md:border-r md:pb-0 md:pr-3"
      >
        {sections
          .filter(([section]) => section !== 'generation' || generationSection)
          .map(([section, testId, label]) => {
            const selected = selection.section === section
            return (
              <button
                key={section}
                type="button"
                aria-expanded={selected}
                aria-current={selected ? 'true' : undefined}
                aria-controls={panelId}
                data-testid={`${testId}-section-trigger`}
                onClick={() => {
                  if (section === 'retrieval') setRetrievalOpened(true)
                  selectSection(section)
                }}
                className={cn(
                  'min-h-11 shrink-0 whitespace-nowrap rounded-md px-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary md:whitespace-normal',
                  selected
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-text-secondary hover:bg-hover'
                )}
              >
                {t(`document.formSections.${label}`)}
              </button>
            )
          })}
      </nav>
      <div
        ref={panel}
        id={panelId}
        tabIndex={-1}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto px-1 pb-3 [scrollbar-gutter:stable]"
      >
        {sections.map(([section, , label]) => {
          const selected = selection.section === section
          // Keep the repository picker draft, summary default, and initialized retrieval settings.
          const keepMounted =
            section === 'basic' ||
            section === 'models' ||
            (section === 'retrieval' && retrievalOpened)
          if (!selected && !keepMounted) return null
          return (
            <section
              key={section}
              hidden={!selected}
              aria-label={t(`document.formSections.${label}`)}
            >
              <SimpleConfigGroup>{content[section]}</SimpleConfigGroup>
            </section>
          )
        })}
      </div>
    </div>
  )
}
