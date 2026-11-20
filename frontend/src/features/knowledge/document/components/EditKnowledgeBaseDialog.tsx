// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { BookOpen, Code2, Database, FileText } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { GenerationTaskRow } from '@/features/knowledge/code-wiki/GenerationTaskRow'
import { GenerationStrategySelect } from '@/features/knowledge/code-wiki/GenerationStrategySelect'
import { ScheduledUpdateSettings } from '@/features/knowledge/code-wiki/ScheduledUpdateSettings'
import { KnowledgeBaseForm, useKnowledgeBaseFormNavigation } from './KnowledgeBaseForm'
import { DingtalkAutoSyncSetting } from './DingtalkAutoSyncSetting'
import { useMultimodalKBConfig } from '@/features/knowledge/multimodal/hooks/useMultimodalKBConfig'
import { useMultimodalFeatureEnabled } from '@/features/knowledge/multimodal/hooks/useMultimodalFeatureEnabled'
import { ConvertKnowledgeBaseTypeDialog } from './ConvertKnowledgeBaseTypeDialog'
import { SimpleConfigRow } from '@/features/settings/components/team-edit/SimpleConfigLayout'
import { ModelRefSelector } from '@/components/model-select/ModelRefSelector'
import { useTranslation } from '@/hooks/useTranslation'
import { getKnowledgeBase, type updateKnowledgeBaseType } from '@/apis/knowledge'
import { codeWikiApi } from '@/apis/code-wiki'
import type {
  DirectAccessRequirement,
  KnowledgeBase,
  KnowledgeBaseUpdate,
  RetrievalConfigDraft,
  RetrievalConfigUpdate,
  SummaryModelRef,
} from '@/types/knowledge'
import type { CodeWikiScheduledUpdateRequest } from '@/types/code-wiki'

type ScheduledUpdateChange =
  | { action: 'configure'; data: CodeWikiScheduledUpdateRequest }
  | { action: 'delete' }
  | null

interface EditKnowledgeBaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  knowledgeBase: KnowledgeBase | null
  spaceName?: string
  onSubmit: (data: KnowledgeBaseUpdate) => Promise<void>
  loading?: boolean
  /** Optional team ID for reading cached model preference (only used when KB has no existing summary_model_ref) */
  knowledgeDefaultTeamId?: number | null
  /** Optional bind model name from team's bot config as fallback */
  bindModel?: string | null
  saveView?: typeof updateKnowledgeBaseType
}

export function EditKnowledgeBaseDialog({
  open,
  onOpenChange,
  knowledgeBase,
  spaceName,
  onSubmit,
  loading,
  knowledgeDefaultTeamId,
  bindModel,
  saveView,
}: EditKnowledgeBaseDialogProps) {
  const { t } = useTranslation('common')
  const { t: tKnowledge } = useTranslation('knowledge')
  const [name, setName] = useState('')
  const [showGenerationTask, setShowGenerationTask] = useState(false)
  const [generationStrategy, setGenerationStrategy] = useState('')
  const [generationStrategyTouched, setGenerationStrategyTouched] = useState(false)
  const isCodeWiki = (knowledgeBase?.kb_type || 'notebook') === 'code_wiki'
  const [description, setDescription] = useState('')
  const [directAccessRequirement, setDirectAccessRequirement] =
    useState<DirectAccessRequirement>('read')
  const [allowDocumentDownload, setAllowDocumentDownload] = useState<boolean | undefined>()
  const [dingtalkAutoSyncEnabled, setDingtalkAutoSyncEnabled] = useState(false)
  const [summaryEnabled, setSummaryEnabled] = useState(false)
  const [summaryModelRef, setSummaryModelRef] = useState<SummaryModelRef | null>(null)
  // Editable so a wiki created before the field existed can be given a model. Left
  // unset it keeps falling back to the team's bot, which is what it runs on today.
  const [executionModelRef, setExecutionModelRef] = useState<SummaryModelRef | null>(null)
  // Whether the model in this dialog is a choice or just what the selector filled in.
  //
  // The selector preselects, so opening this dialog on a wiki that has no model puts
  // one in the box without anyone asking. Sending that on submit would pin a model
  // nobody chose -- and replace the team fallback the wiki runs on -- as a side
  // effect of saving some unrelated setting. So the field is only sent once it has
  // been touched, or when the wiki already had one to update.
  const [executionModelTouched, setExecutionModelTouched] = useState(false)
  const [summaryModelError, setSummaryModelError] = useState('')
  const {
    multimodalAnalysisEnabled,
    multimodalVideoPrompt,
    multimodalImagePrompt,
    loadFromKB: loadMultimodalFromKB,
    validate: validateMultimodal,
    clearError: clearMultimodalError,
    buildSubmitFields: buildMultimodalSubmitFields,
    formProps: multimodalFormProps,
  } = useMultimodalKBConfig()
  // Gate prompt overrides by the global pipeline switch, the same way
  // buildMultimodalSubmitFields() gates multimodal_analysis_enabled. Otherwise
  // saving a previously-enabled KB after the switch is turned off would send
  // enabled=false alongside the (non-blank) prompt text.
  const multimodalFeatureEnabled = useMultimodalFeatureEnabled()
  const effectiveMultimodalEnabled = multimodalFeatureEnabled && multimodalAnalysisEnabled
  const [error, setError] = useState('')
  const navigation = useKnowledgeBaseFormNavigation()
  const { selectSection } = navigation
  const [retrievalConfig, setRetrievalConfig] = useState<RetrievalConfigDraft>({})
  const [guidedQuestions, setGuidedQuestions] = useState<string[]>([])

  // Call limit configuration state
  const [maxCalls, setMaxCalls] = useState(10)
  const [exemptCalls, setExemptCalls] = useState(5)

  // Default view dialog state
  const [showConvertDialog, setShowConvertDialog] = useState(false)
  const [convertedView, setConvertedView] = useState<KnowledgeBase['kb_type']>()
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [scheduledUpdateChange, setScheduledUpdateChange] = useState<ScheduledUpdateChange>(null)
  const [isSavingChanges, setIsSavingChanges] = useState(false)

  // Full knowledge base data (fetched from API)
  const [fullKnowledgeBase, setFullKnowledgeBase] = useState<KnowledgeBase | null>(null)
  const [isLoadingFullKnowledgeBase, setIsLoadingFullKnowledgeBase] = useState(false)
  const [fullKnowledgeBaseLoadFailed, setFullKnowledgeBaseLoadFailed] = useState(false)
  const fullKnowledgeBaseRequestId = useRef(0)

  const loadFullKnowledgeBase = useCallback(
    async (knowledgeBaseId: number) => {
      const requestId = ++fullKnowledgeBaseRequestId.current
      selectSection('basic')
      setShowConvertDialog(false)
      setConvertedView(undefined)
      setFullKnowledgeBase(null)
      setIsLoadingFullKnowledgeBase(true)
      setFullKnowledgeBaseLoadFailed(false)

      try {
        const fullKb = await getKnowledgeBase(knowledgeBaseId)
        if (fullKnowledgeBaseRequestId.current === requestId) {
          setFullKnowledgeBase(fullKb)
        }
      } catch (err) {
        console.error('Failed to fetch full knowledge base data:', err)
        if (fullKnowledgeBaseRequestId.current === requestId) {
          setFullKnowledgeBaseLoadFailed(true)
        }
      } finally {
        if (fullKnowledgeBaseRequestId.current === requestId) {
          setIsLoadingFullKnowledgeBase(false)
        }
      }
    },
    [selectSection]
  )

  // Fetch full knowledge base data when dialog opens
  useEffect(() => {
    if (open && knowledgeBase?.id) {
      void loadFullKnowledgeBase(knowledgeBase.id)
    } else {
      fullKnowledgeBaseRequestId.current += 1
      setShowConvertDialog(false)
      setFullKnowledgeBase(null)
      setIsLoadingFullKnowledgeBase(false)
      setFullKnowledgeBaseLoadFailed(false)
    }

    return () => {
      fullKnowledgeBaseRequestId.current += 1
    }
  }, [open, knowledgeBase?.id, loadFullKnowledgeBase])

  // Initialize form fields when full data is loaded
  useEffect(() => {
    if (fullKnowledgeBase) {
      const kb = fullKnowledgeBase
      setName(kb.name)
      setDescription(kb.description || '')
      setDirectAccessRequirement(kb.direct_access_requirement ?? 'read')
      setAllowDocumentDownload(kb.allow_document_download)
      setDingtalkAutoSyncEnabled(kb.dingtalk_auto_sync_enabled ?? false)
      setSummaryEnabled(kb.summary_enabled || false)
      setSummaryModelRef(kb.summary_model_ref || null)
      setExecutionModelRef(kb.execution_model_ref || null)
      setExecutionModelTouched(false)
      setScheduledUpdateChange(null)
      setScheduleError(null)
      setSummaryModelError('')
      loadMultimodalFromKB({
        multimodalAnalysisEnabled: kb.multimodal_analysis_enabled || false,
        multimodalAnalysisModelRef: kb.multimodal_analysis_model_ref || null,
        multimodalAnalysisModelError: '',
        multimodalVideoPrompt: kb.multimodal_analysis_video_prompt ?? null,
        multimodalImagePrompt: kb.multimodal_analysis_image_prompt ?? null,
      })
      setShowGenerationTask(kb.show_generation_task ?? false)
      setGenerationStrategy(kb.generation_strategy || '')
      setGenerationStrategyTouched(false)
      // Initialize retrieval config from knowledge base
      if (kb.retrieval_config) {
        setRetrievalConfig(kb.retrieval_config)
      }
      // Initialize call limits from knowledge base
      setMaxCalls(kb.max_calls_per_conversation)
      setExemptCalls(kb.exempt_calls_before_check)
      // Initialize guided questions from knowledge base
      setGuidedQuestions(kb.guided_questions || [])
    }
  }, [fullKnowledgeBase])

  const handleRetrievalConfigChange = useCallback((config: RetrievalConfigDraft) => {
    setRetrievalConfig(config)
  }, [])

  const validateScheduledChange = () => {
    if (scheduledUpdateChange?.action !== 'configure') return true
    const { cadence, interval_days: days } = scheduledUpdateChange.data
    if (cadence !== 'custom' || (Number.isInteger(days) && days >= 2 && days <= 365)) return true

    setError(tKnowledge('codeWiki.scheduledUpdate.invalidCustomDays'))
    selectSection('generation', '[data-testid="code-wiki-scheduled-custom-days"]')
    return false
  }

  const saveScheduledChange = async (kbId: number) => {
    try {
      if (scheduledUpdateChange?.action === 'configure') {
        await codeWikiApi.configureScheduledUpdate(kbId, scheduledUpdateChange.data)
      } else if (scheduledUpdateChange?.action === 'delete') {
        await codeWikiApi.deleteScheduledUpdate(kbId)
      }
      handleOpenChange(false)
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : t('common:error'))
      selectSection('generation')
    }
  }

  const retryScheduledChange = async () => {
    if (!fullKnowledgeBase || !scheduledUpdateChange || isSavingChanges) return
    setError('')
    if (!validateScheduledChange()) return
    setIsSavingChanges(true)
    try {
      await saveScheduledChange(fullKnowledgeBase.id)
    } finally {
      setIsSavingChanges(false)
    }
  }

  const handleSubmit = async () => {
    setError('')
    setSummaryModelError('')
    clearMultimodalError()

    if (!fullKnowledgeBase) {
      return
    }

    if (!name.trim()) {
      setError(t('knowledge:document.knowledgeBase.nameRequired'))
      selectSection('basic', '#knowledge-name')
      return
    }

    if (name.length > 100) {
      setError(t('knowledge:document.knowledgeBase.nameTooLong'))
      selectSection('basic', '#knowledge-name')
      return
    }

    // Validate summary model when summary is enabled
    if (summaryEnabled && !summaryModelRef) {
      setSummaryModelError(t('knowledge:document.summary.modelRequired'))
      selectSection('models', '[data-testid="summary-model-select"]')
      return
    }

    // Validate multimodal analysis model when multimodal analysis is enabled
    if (!validateMultimodal()) {
      selectSection('models', '[data-testid="multimodal-analysis-model-select"]')
      return
    }

    if (!validateScheduledChange()) return

    // Validate call limits
    if (exemptCalls >= maxCalls) {
      setError(t('knowledge:document.callLimits.validationError'))
      selectSection('usage', '#knowledge-exempt-calls [role="slider"]')
      return
    }

    setIsSavingChanges(true)
    try {
      // Build update data
      // Filter out empty guided questions
      const validGuidedQuestions = guidedQuestions.filter(q => q.trim().length > 0)
      const kb = fullKnowledgeBase
      const updateData: KnowledgeBaseUpdate = {
        name: name.trim(),
        description: description.trim(), // Allow empty string to clear description
        direct_access_requirement: directAccessRequirement,
        allow_document_download: allowDocumentDownload,
        dingtalk_auto_sync_enabled: dingtalkAutoSyncEnabled,
        summary_enabled: summaryEnabled,
        summary_model_ref: summaryEnabled ? summaryModelRef : null,
        ...buildMultimodalSubmitFields(),
        // For edit, send "" (never null) so the backend always applies the value:
        // a blank string clears the override (revert to system default).
        multimodal_analysis_video_prompt: effectiveMultimodalEnabled
          ? multimodalVideoPrompt || ''
          : '',
        multimodal_analysis_image_prompt: effectiveMultimodalEnabled
          ? multimodalImagePrompt || ''
          : '',
        guided_questions: validGuidedQuestions,
        max_calls_per_conversation: maxCalls,
        exempt_calls_before_check: exemptCalls,
        ...(isCodeWiki ? { show_generation_task: showGenerationTask } : {}),
        ...(isCodeWiki && generationStrategyTouched && generationStrategy
          ? { generation_strategy: generationStrategy }
          : {}),
        // Applies to the next run. One already going keeps the model it was started
        // with, which is the model its pages were written by. Omitted entirely when
        // untouched on a wiki that had none, so "unset" survives an unrelated save.
        ...(isCodeWiki && (executionModelTouched || kb?.execution_model_ref)
          ? { execution_model_ref: executionModelRef }
          : {}),
      }

      // Add retrieval config update if advanced settings were modified
      if (kb?.retrieval_config && retrievalConfig) {
        const retrievalConfigUpdate: RetrievalConfigUpdate = {}

        // Only include fields that can be updated (exclude retriever and embedding_config)
        if (retrievalConfig.retrieval_mode !== undefined) {
          retrievalConfigUpdate.retrieval_mode = retrievalConfig.retrieval_mode
        }
        if (retrievalConfig.top_k !== undefined) {
          retrievalConfigUpdate.top_k = retrievalConfig.top_k
        }
        if (retrievalConfig.score_threshold !== undefined) {
          retrievalConfigUpdate.score_threshold = retrievalConfig.score_threshold
        }
        if (retrievalConfig.hybrid_weights !== undefined) {
          retrievalConfigUpdate.hybrid_weights = retrievalConfig.hybrid_weights
        }

        // Only add retrieval_config if there are changes
        if (Object.keys(retrievalConfigUpdate).length > 0) {
          updateData.retrieval_config = retrievalConfigUpdate
        }
      }

      await onSubmit(updateData)

      await saveScheduledChange(fullKnowledgeBase.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:error'))
    } finally {
      setIsSavingChanges(false)
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setError('')
      setSummaryModelError('')
      clearMultimodalError()
      setScheduledUpdateChange(null)
      setScheduleError(null)
    }
    onOpenChange(newOpen)
  }

  const kb = fullKnowledgeBase
  const kbType = convertedView ?? kb?.kb_type ?? 'notebook'
  const isNotebook = kbType === 'notebook'

  // Handle default opening view update success
  const handleTypeConverted = (updatedKb: KnowledgeBase) => {
    setShowConvertDialog(false)
    setConvertedView(updatedKb.kb_type)
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={nextOpen => {
          if (!nextOpen && isSavingChanges) return
          handleOpenChange(nextOpen)
        }}
      >
        <DialogContent
          className="w-[calc(100%_-_1rem)] max-w-4xl h-[min(90dvh,46rem)] overflow-hidden flex flex-col"
          closeButtonProps={{
            className: 'right-2 top-2 flex h-11 w-11 items-center justify-center',
            'data-testid': 'close-edit-kb',
          }}
        >
          <DialogHeader className="shrink-0 pr-8">
            <DialogTitle>{t('knowledge:document.knowledgeBase.edit')}</DialogTitle>
            <DialogDescription>
              {t('knowledge:document.knowledgeBase.editDialogDescription')}
            </DialogDescription>
          </DialogHeader>
          {isLoadingFullKnowledgeBase ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner
                center
                text={tKnowledge('document.knowledgeBase.loadingDetails')}
                data-testid="edit-knowledge-base-loading"
              />
            </div>
          ) : fullKnowledgeBaseLoadFailed ? (
            <div
              className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto text-center"
              data-testid="edit-knowledge-base-load-error"
            >
              <p className="text-sm text-error">
                {tKnowledge('document.knowledgeBase.loadDetailsFailed')}
              </p>
              <Button
                variant="outline"
                onClick={() => knowledgeBase?.id && loadFullKnowledgeBase(knowledgeBase.id)}
                className="min-h-11 min-w-11"
                data-testid="edit-knowledge-base-retry"
              >
                {tKnowledge('document.knowledgeBase.retryLoadDetails')}
              </Button>
            </div>
          ) : fullKnowledgeBase ? (
            <>
              <KnowledgeBaseForm
                disabled={isSavingChanges}
                editableSection={scheduleError ? 'generation' : undefined}
                navigation={navigation}
                kindSection={
                  <div className="flex items-center gap-3 rounded-md border border-primary/20 bg-primary/5 p-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                      {isCodeWiki ? (
                        <Code2 className="h-4 w-4" />
                      ) : (
                        <FileText className="h-4 w-4" />
                      )}
                    </div>
                    <div>
                      <div className="text-sm font-medium">
                        {tKnowledge(
                          isCodeWiki
                            ? 'document.knowledgeBase.kindCode'
                            : 'document.knowledgeBase.kindDocument'
                        )}
                      </div>
                      <div className="text-xs text-text-muted">
                        {tKnowledge(
                          isCodeWiki
                            ? 'document.knowledgeBase.kindCodeDesc'
                            : 'document.knowledgeBase.kindDocumentDesc'
                        )}
                      </div>
                    </div>
                  </div>
                }
                locationSection={
                  <SimpleConfigRow label={tKnowledge('document.navigation.space')}>
                    <p className="break-words text-sm text-text-primary">
                      {spaceName ||
                        (kb?.namespace === 'default'
                          ? tKnowledge('document.navigation.personalSpace')
                          : kb?.namespace)}
                    </p>
                  </SimpleConfigRow>
                }
                typeSection={
                  isCodeWiki ? (
                    <>
                      {kb?.source?.sourceUrl && (
                        <SimpleConfigRow label={tKnowledge('codeWiki.create.repository')}>
                          <p className="break-all text-sm" title={kb.source.sourceUrl}>
                            {kb.source.projectName || kb.source.sourceUrl}
                          </p>
                        </SimpleConfigRow>
                      )}
                      <SimpleConfigRow
                        label={tKnowledge('codeWiki.create.modelLabel')}
                        description={tKnowledge('codeWiki.create.modelDescription')}
                        align="start"
                      >
                        <ModelRefSelector
                          value={executionModelRef}
                          onChange={value => {
                            setExecutionModelRef(value)
                            setExecutionModelTouched(true)
                          }}
                          placeholder={tKnowledge('codeWiki.create.modelPlaceholder')}
                          // Passed unconditionally: with autoSelect off it no longer
                          // risks the cache overriding what the wiki already has, and
                          // it is what lets a pick made here be remembered.
                          knowledgeDefaultTeamId={knowledgeDefaultTeamId}
                          preferenceScope="wiki"
                          // Nothing is filled in for a wiki that has no model: an empty
                          // box is the truth there, and only a real pick may change it.
                          autoSelect={false}
                          dataTestId="code-wiki-execution-model-select"
                        />
                      </SimpleConfigRow>
                    </>
                  ) : (
                    <SimpleConfigRow
                      label={tKnowledge('document.knowledgeBase.type')}
                      align="start"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex items-center gap-2 text-sm text-text-primary">
                          {isNotebook ? (
                            <BookOpen className="h-4 w-4" />
                          ) : (
                            <Database className="h-4 w-4" />
                          )}
                          {tKnowledge(
                            isNotebook
                              ? 'document.knowledgeBase.typeNotebook'
                              : 'document.knowledgeBase.typeClassic'
                          )}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setShowConvertDialog(true)}
                          className="min-h-11 min-w-11"
                          data-testid="edit-kb-default-view"
                        >
                          {tKnowledge('document.knowledgeBase.changeDefaultView')}
                        </Button>
                      </div>
                    </SimpleConfigRow>
                  )
                }
                generationSection={
                  isCodeWiki ? (
                    <>
                      {!scheduleError && (
                        <SimpleConfigRow
                          label={tKnowledge('codeWiki.strategy.label')}
                          description={tKnowledge('codeWiki.strategy.settingsDescription')}
                        >
                          <GenerationStrategySelect
                            value={generationStrategy}
                            onChange={strategy => {
                              setGenerationStrategy(strategy)
                              setGenerationStrategyTouched(true)
                            }}
                            testId="code-wiki-generation-strategy"
                          />
                        </SimpleConfigRow>
                      )}
                      <SimpleConfigRow
                        label={tKnowledge('codeWiki.create.scheduledUpdate')}
                        description={tKnowledge('codeWiki.scheduledUpdate.settingsHint')}
                        align="start"
                      >
                        <ScheduledUpdateSettings
                          key={fullKnowledgeBase.id}
                          knowledgeBaseId={fullKnowledgeBase.id}
                          draft={
                            scheduledUpdateChange?.action === 'configure'
                              ? scheduledUpdateChange.data
                              : null
                          }
                          deleteRequested={scheduledUpdateChange?.action === 'delete'}
                          retryingSave={!!scheduleError}
                          onDraftSaved={data => {
                            setError('')
                            setScheduledUpdateChange({ action: 'configure', data })
                          }}
                          onDeleteRequested={() => setScheduledUpdateChange({ action: 'delete' })}
                        />
                      </SimpleConfigRow>
                      {scheduledUpdateChange && !scheduleError && (
                        <p
                          className="text-xs text-text-muted"
                          data-testid="code-wiki-scheduled-pending-change"
                        >
                          {tKnowledge(
                            scheduledUpdateChange.action === 'delete'
                              ? 'codeWiki.scheduledUpdate.pendingDelete'
                              : 'codeWiki.scheduledUpdate.pendingConfigure'
                          )}
                        </p>
                      )}
                      {!scheduleError && (
                        <GenerationTaskRow
                          checked={showGenerationTask}
                          onChange={setShowGenerationTask}
                        />
                      )}
                    </>
                  ) : undefined
                }
                documentSyncSetting={
                  !isCodeWiki && (
                    <DingtalkAutoSyncSetting
                      checked={dingtalkAutoSyncEnabled}
                      onCheckedChange={setDingtalkAutoSyncEnabled}
                    />
                  )
                }
                name={name}
                description={description}
                onNameChange={value => setName(value)}
                onDescriptionChange={value => setDescription(value)}
                directAccessRequirement={directAccessRequirement}
                onDirectAccessRequirementChange={setDirectAccessRequirement}
                allowDocumentDownload={allowDocumentDownload}
                onAllowDocumentDownloadChange={setAllowDocumentDownload}
                summaryEnabled={summaryEnabled}
                onSummaryEnabledChange={checked => {
                  setSummaryEnabled(checked)
                  if (!checked) {
                    setSummaryModelRef(null)
                    setSummaryModelError('')
                  }
                }}
                summaryModelRef={summaryModelRef}
                summaryModelError={summaryModelError}
                onSummaryModelChange={value => {
                  setSummaryModelRef(value)
                  setSummaryModelError('')
                }}
                {...multimodalFormProps}
                knowledgeDefaultTeamId={!kb?.summary_model_ref ? knowledgeDefaultTeamId : undefined}
                bindModel={bindModel}
                callLimits={{ maxCalls, exemptCalls }}
                onCallLimitsChange={({ maxCalls: nextMax, exemptCalls: nextExempt }) => {
                  setMaxCalls(nextMax)
                  setExemptCalls(nextExempt)
                }}
                retrievalModeSection={
                  <p className="text-sm text-text-secondary">
                    {tKnowledge(
                      kb?.retrieval_config
                        ? 'document.ragConfigMode.auto'
                        : 'document.ragConfigMode.disabled'
                    )}
                  </p>
                }
                showRetrievalSection={!!kb?.retrieval_config}
                retrievalConfig={retrievalConfig}
                onRetrievalConfigChange={handleRetrievalConfigChange}
                retrievalReadOnly={false}
                retrievalPartialReadOnly={true}
                showGuidedQuestions={true}
                guidedQuestions={guidedQuestions}
                onGuidedQuestionsChange={setGuidedQuestions}
              />
              {scheduleError && (
                <div role="alert" className="shrink-0 text-sm text-error">
                  <p>{tKnowledge('codeWiki.scheduledUpdate.saveFailedAfterKnowledgeBase')}</p>
                  <p className="break-words">{scheduleError}</p>
                </div>
              )}
              {error && (
                <p role="alert" className="shrink-0 text-sm text-error">
                  {error}
                </p>
              )}
            </>
          ) : null}
          <DialogFooter className="shrink-0 flex-row justify-end gap-2 space-y-0">
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={loading || isSavingChanges}
              className="h-11 min-w-[44px]"
            >
              {t(scheduleError ? 'common:actions.close' : 'common:actions.cancel')}
            </Button>
            <Button
              onClick={scheduleError ? retryScheduledChange : handleSubmit}
              data-testid={scheduleError ? 'code-wiki-scheduled-save-retry' : 'edit-kb-save'}
              variant="primary"
              disabled={
                loading || isSavingChanges || isLoadingFullKnowledgeBase || !fullKnowledgeBase
              }
              className="h-11 min-w-[44px]"
            >
              {loading || isSavingChanges
                ? t('common:actions.saving')
                : scheduleError
                  ? tKnowledge('codeWiki.scheduledUpdate.retrySave')
                  : t('common:actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Convert type dialog */}
      <ConvertKnowledgeBaseTypeDialog
        open={open && showConvertDialog && kb?.id === knowledgeBase?.id}
        onOpenChange={setShowConvertDialog}
        knowledgeBase={kb && kb.id === knowledgeBase?.id ? { ...kb, kb_type: kbType } : null}
        saveView={saveView}
        onSessionSaved={handleTypeConverted}
      />
    </>
  )
}
