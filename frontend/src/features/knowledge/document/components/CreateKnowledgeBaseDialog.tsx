// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { BookOpen, Code2, Database, User, Building2, Users, FileText } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { SimpleConfigRow } from '@/features/settings/components/team-edit/SimpleConfigLayout'
import { ModelRefSelector } from '@/components/model-select/ModelRefSelector'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import {
  CodeWikiSourceFields,
  type CodeWikiSource,
} from '@/features/knowledge/code-wiki/CodeWikiSourceFields'
import type {
  DirectAccessRequirement,
  KnowledgeBaseCreate,
  SummaryModelRef,
  KnowledgeBaseType,
  RetrievalConfigDraft,
  RagConfigMode,
} from '@/types/knowledge'
import { GenerationTaskRow } from '@/features/knowledge/code-wiki/GenerationTaskRow'
import { KnowledgeBaseForm } from './KnowledgeBaseForm'
import { useMultimodalKBConfig } from '@/features/knowledge/multimodal/hooks/useMultimodalKBConfig'

/** Available group for selection */
export interface AvailableGroup {
  id: string
  name: string
  displayName: string
  type: 'personal' | 'group' | 'organization' | 'dingtalk'
  canCreate: boolean
}

interface CreateKnowledgeBaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (
    data: Omit<KnowledgeBaseCreate, 'namespace'> & {
      /** Selected group ID for creating the KB */
      selectedGroupId?: string
    }
  ) => Promise<void>
  loading?: boolean
  scope?: 'personal' | 'group' | 'organization' | 'all'
  groupName?: string
  /** Knowledge base type selected from dropdown menu (read-only in dialog) */
  kbType?: KnowledgeBaseType
  /** Optional team ID for reading cached model preference */
  knowledgeDefaultTeamId?: number | null
  /** Optional bind model name from team's bot config as fallback */
  bindModel?: string | null
  /** Available groups for selection (for "All" mode) */
  availableGroups?: AvailableGroup[]
  /** Default selected group ID */
  defaultGroupId?: string
  /** Whether to show group selector (true when creating from "All" page) */
  showGroupSelector?: boolean
}

/** Get icon for group type */
function GroupTypeIcon({ type }: { type: 'personal' | 'group' | 'organization' | 'dingtalk' }) {
  switch (type) {
    case 'personal':
      return <User className="w-4 h-4" />
    case 'organization':
      return <Building2 className="w-4 h-4" />
    case 'dingtalk':
      return <FileText className="w-4 h-4" />
    case 'group':
    default:
      return <Users className="w-4 h-4" />
  }
}

function createDefaultRetrievalConfig(): RetrievalConfigDraft {
  return {
    retrieval_mode: 'vector',
    top_k: 5,
    score_threshold: 0.5,
    hybrid_weights: {
      vector_weight: 0.7,
      keyword_weight: 0.3,
    },
  }
}

/** Documents are uploaded and organised; code is generated from a repository. */
type KnowledgeBaseKind = 'document' | 'code'

function createEmptySource(): CodeWikiSource {
  return {
    source_type: 'github',
    source_url: '',
    language: 'zh',
    show_generation_task: false,
    resolution: null,
  }
}

export function CreateKnowledgeBaseDialog({
  open,
  onOpenChange,
  onSubmit,
  loading,
  scope,
  groupName,
  kbType: initialKbType = 'notebook',
  knowledgeDefaultTeamId,
  bindModel,
  availableGroups,
  defaultGroupId,
  showGroupSelector = false,
}: CreateKnowledgeBaseDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [directAccessRequirement, setDirectAccessRequirement] =
    useState<DirectAccessRequirement>('read')
  // Selected KB type (can be changed by user)
  const [selectedKbType, setSelectedKbType] = useState<KnowledgeBaseType>(initialKbType)
  // Which kind of knowledge base is being created. Chosen first because it decides
  // which fields even apply: a code wiki has a repository and no opening view.
  const [kind, setKind] = useState<KnowledgeBaseKind>('document')
  // Staged rollout: creating code wikis is off unless the deployment opts in.
  // Reading and regenerating existing ones is unaffected, here and on the server.
  const kindOptions = (
    [
      ['document', FileText, 'knowledge:document.knowledgeBase.kindDocument'],
      ...(getRuntimeConfigSync().enableCodeWiki
        ? [['code', Code2, 'knowledge:document.knowledgeBase.kindCode'] as const]
        : []),
    ] as const
  ).filter(Boolean) as ReadonlyArray<readonly [KnowledgeBaseKind, typeof FileText, string]>
  const [source, setSource] = useState<CodeWikiSource>(createEmptySource)
  // Default enable summary for all KB types
  const [summaryEnabled, setSummaryEnabled] = useState(true)
  const [summaryModelRef, setSummaryModelRef] = useState<SummaryModelRef | null>(null)
  const [summaryModelError, setSummaryModelError] = useState('')
  // Which model reads the repository. Required for a code wiki rather than
  // inherited from the team's bot: a wiki hands a whole codebase to whichever
  // model it names, so that has to be a choice the creator sees themselves making.
  const [executionModelRef, setExecutionModelRef] = useState<SummaryModelRef | null>(null)
  const [executionModelError, setExecutionModelError] = useState('')
  const {
    validate: validateMultimodal,
    clearError: clearMultimodalError,
    reset: resetMultimodal,
    buildSubmitFields: buildMultimodalSubmitFields,
    formProps: multimodalFormProps,
  } = useMultimodalKBConfig()
  const [guidedQuestions, setGuidedQuestions] = useState<string[]>([])
  const [ragConfigMode, setRagConfigMode] = useState<RagConfigMode>('auto')
  const [retrievalConfig, setRetrievalConfig] = useState<RetrievalConfigDraft>(
    createDefaultRetrievalConfig
  )
  const [error, setError] = useState('')
  const [accordionValue, setAccordionValue] = useState<string>('')
  const [maxCalls, setMaxCalls] = useState(10)
  const [exemptCalls, setExemptCalls] = useState(5)
  // Selected group for creating KB (used when showGroupSelector is true)
  const [selectedGroupId, setSelectedGroupId] = useState<string>(defaultGroupId || 'personal')

  // Get the selected group for retrieval scope
  const selectedGroup = availableGroups?.find(g => g.id === selectedGroupId)
  // Map dingtalk to personal scope since KBs cannot be created in dingtalk scope
  const mapScope = (
    t: 'personal' | 'group' | 'organization' | 'dingtalk' | 'all' | undefined
  ): 'personal' | 'organization' | 'group' | 'all' => {
    if (t === 'dingtalk') return 'personal'
    return t || 'personal'
  }
  const effectiveScope = mapScope(showGroupSelector && selectedGroup ? selectedGroup.type : scope)
  const effectiveGroupName =
    showGroupSelector && selectedGroup && selectedGroup.type === 'group'
      ? selectedGroup.name
      : groupName

  // Reset selectedKbType and selectedGroupId when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedKbType(initialKbType)
      setKind('document')
      setSource(createEmptySource())
      setSelectedGroupId(defaultGroupId || 'personal')
      setDirectAccessRequirement('read')
    }
  }, [open, initialKbType, defaultGroupId])

  // Update selectedKbType when KB type changes (keep summaryEnabled unchanged)
  const handleKbTypeChange = (newType: KnowledgeBaseType) => {
    setSelectedKbType(newType)
  }

  const handleSubmit = async () => {
    setError('')
    setSummaryModelError('')
    setExecutionModelError('')
    clearMultimodalError()

    // A code wiki may be left unnamed: the server fills in the repository's own
    // name. Pre-filling the box here instead would read as the caller's own input.
    if (!name.trim() && kind !== 'code') {
      setError(t('knowledge:document.knowledgeBase.nameRequired'))
      return
    }

    if (kind === 'code' && !source.source_url) {
      setError(t('knowledge:codeWiki.create.repositoryRequired'))
      return
    }

    if (kind === 'code' && !executionModelRef) {
      setExecutionModelError(t('knowledge:codeWiki.create.modelRequired'))
      return
    }

    if (name.length > 100) {
      setError(t('knowledge:document.knowledgeBase.nameTooLong'))
      return
    }

    // Validate summary model when summary is enabled
    if (summaryEnabled && !summaryModelRef) {
      setSummaryModelError(t('knowledge:document.summary.modelRequired'))
      return
    }

    // Validate multimodal analysis model when multimodal analysis is enabled
    if (!validateMultimodal()) {
      return
    }

    // Validate call limits
    if (exemptCalls >= maxCalls) {
      setError(t('knowledge:document.callLimits.validationError'))
      setAccordionValue('advanced')
      return
    }

    try {
      // Filter out empty guided questions
      const validGuidedQuestions = guidedQuestions.filter(q => q.trim().length > 0)
      await onSubmit({
        name: name.trim(),
        description: description.trim() || undefined,
        direct_access_requirement: directAccessRequirement,
        retrieval_config: ragConfigMode === 'disabled' ? undefined : retrievalConfig,
        rag_config_mode: ragConfigMode,
        summary_enabled: summaryEnabled,
        summary_model_ref: summaryEnabled ? summaryModelRef : null,
        ...buildMultimodalSubmitFields(),
        guided_questions: validGuidedQuestions.length > 0 ? validGuidedQuestions : undefined,
        max_calls_per_conversation: maxCalls,
        exempt_calls_before_check: exemptCalls,
        selectedGroupId: showGroupSelector ? selectedGroupId : undefined,
        kb_type: kind === 'code' ? 'code_wiki' : selectedKbType,
        ...(kind === 'code'
          ? {
              source_type: source.source_type,
              source_url: source.source_url,
              language: source.language,
              show_generation_task: source.show_generation_task,
              // Left blank, the repository's own name is used. Sent from what the
              // form already resolved rather than pre-filled into the box, which
              // would read as the caller's own input — and rather than resolved
              // again on the server, which has asked the provider once already.
              resolved_name: source.resolution?.name,
              resolved_description: source.resolution?.description,
              execution_model_ref: executionModelRef,
            }
          : {}),
      })
      setName('')
      setDescription('')
      setDirectAccessRequirement('read')
      // Reset selectedKbType and keep summaryEnabled as true
      setSelectedKbType(initialKbType)
      setKind('document')
      setSource(createEmptySource())
      setSummaryEnabled(true)
      setSummaryModelRef(null)
      setExecutionModelRef(null)
      resetMultimodal()
      setGuidedQuestions([])
      setRagConfigMode('auto')
      setRetrievalConfig(createDefaultRetrievalConfig())
      setMaxCalls(10)
      setExemptCalls(5)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:error'))
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setName('')
      setDescription('')
      setDirectAccessRequirement('read')
      // Reset selectedKbType and keep summaryEnabled as true
      setSelectedKbType(initialKbType)
      setKind('document')
      setSource(createEmptySource())
      setSummaryEnabled(true)
      setSummaryModelRef(null)
      setExecutionModelRef(null)
      setSummaryModelError('')
      resetMultimodal()
      setGuidedQuestions([])
      setRagConfigMode('auto')
      setRetrievalConfig(createDefaultRetrievalConfig())
      setMaxCalls(10)
      setExemptCalls(5)
      setError('')
      setAccordionValue('')
      setSelectedGroupId(defaultGroupId || 'personal')
    }
    onOpenChange(newOpen)
  }

  // Determine if this is a notebook type
  const isNotebook = selectedKbType === 'notebook'
  const ragModeOptions: RagConfigMode[] = ['auto', 'disabled']

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col"
        data-testid="create-kb-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('knowledge:document.knowledgeBase.create')}</DialogTitle>
          <DialogDescription>
            {t('knowledge:document.knowledgeBase.createDialogDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-4 py-4 pr-3 [scrollbar-gutter:stable]">
          {/* Which kind first: it decides which of the fields below even apply. The
              choice disappears entirely while code wikis are off, rather than being
              shown disabled: an option nobody in this deployment can pick is noise,
              and the server refuses the call regardless. */}
          <div className={`grid gap-3 ${kindOptions.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {kindOptions.map(([option, Icon, label]) => (
              <button
                key={option}
                type="button"
                onClick={() => setKind(option)}
                data-testid={`create-kb-kind-${option}`}
                className={`flex items-center gap-3 p-3 rounded-md border transition-colors ${
                  kind === option
                    ? 'bg-primary/5 border-primary/20'
                    : 'bg-muted border-border hover:bg-hover'
                }`}
              >
                <div
                  className={`flex-shrink-0 w-8 h-8 rounded-md flex items-center justify-center ${
                    kind === option
                      ? 'bg-primary/10 text-primary'
                      : 'bg-surface text-text-secondary'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </div>
                <div className="text-left">
                  <div className="font-medium text-sm">{t(label)}</div>
                  <div className="text-xs text-text-muted">{t(`${label}Desc`)}</div>
                </div>
              </button>
            ))}
          </div>
          <KnowledgeBaseForm
            advancedExtras={
              kind === 'code' ? (
                <GenerationTaskRow
                  checked={source.show_generation_task}
                  onChange={checked => setSource({ ...source, show_generation_task: checked })}
                />
              ) : undefined
            }
            nameRequired={kind !== 'code'}
            namePlaceholder={
              kind === 'code' ? t('knowledge:codeWiki.create.namePlaceholder') : undefined
            }
            typeSection={
              <>
                {kind === 'code' ? (
                  <>
                    <CodeWikiSourceFields value={source} onChange={setSource} />
                    <SimpleConfigRow
                      label={t('knowledge:codeWiki.create.modelLabel')}
                      description={t('knowledge:codeWiki.create.modelDescription')}
                      align="start"
                    >
                      <ModelRefSelector
                        value={executionModelRef}
                        onChange={setExecutionModelRef}
                        error={executionModelError}
                        placeholder={t('knowledge:codeWiki.create.modelPlaceholder')}
                        knowledgeDefaultTeamId={knowledgeDefaultTeamId}
                        bindModel={bindModel}
                        preferenceScope="wiki"
                        dataTestId="code-wiki-execution-model-select"
                      />
                    </SimpleConfigRow>
                  </>
                ) : (
                  /* KB Type selector - subtle style */
                  <SimpleConfigRow label={t('knowledge:document.knowledgeBase.type')} align="start">
                    <div className="space-y-2">
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => handleKbTypeChange(isNotebook ? 'classic' : 'notebook')}
                          className="text-xs text-text-muted hover:text-primary transition-colors"
                          data-testid="switch-kb-type"
                        >
                          {isNotebook
                            ? t('knowledge:document.knowledgeBase.convertToClassic')
                            : t('knowledge:document.knowledgeBase.convertToNotebook')}
                        </button>
                      </div>
                      <div
                        className={`flex items-center gap-3 p-3 rounded-md border ${
                          isNotebook ? 'bg-primary/5 border-primary/20' : 'bg-muted border-border'
                        }`}
                      >
                        <div
                          className={`flex-shrink-0 w-8 h-8 rounded-md flex items-center justify-center ${
                            isNotebook
                              ? 'bg-primary/10 text-primary'
                              : 'bg-surface text-text-secondary'
                          }`}
                        >
                          {isNotebook ? (
                            <BookOpen className="w-4 h-4" />
                          ) : (
                            <Database className="w-4 h-4" />
                          )}
                        </div>
                        <div>
                          <div className="font-medium text-sm">
                            {isNotebook
                              ? t('knowledge:document.knowledgeBase.typeNotebook')
                              : t('knowledge:document.knowledgeBase.typeClassic')}
                          </div>
                          <div className="text-xs text-text-muted">
                            {isNotebook
                              ? t('knowledge:document.knowledgeBase.notebookDesc')
                              : t('knowledge:document.knowledgeBase.classicDesc')}
                          </div>
                        </div>
                      </div>
                    </div>
                  </SimpleConfigRow>
                )}
                {/* Group selector - only show when showGroupSelector is true */}
                {showGroupSelector && availableGroups && availableGroups.length > 0 && (
                  <SimpleConfigRow
                    label={
                      <>
                        {t('knowledge:document.knowledgeBase.targetGroup', '归属')}{' '}
                        <span className="text-red-400">*</span>
                      </>
                    }
                  >
                    <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
                      <SelectTrigger data-testid="group-selector" className="bg-base">
                        <SelectValue
                          placeholder={t(
                            'knowledge:document.knowledgeBase.selectGroup',
                            '选择分组'
                          )}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {availableGroups
                          .filter(g => g.canCreate)
                          .map(group => (
                            <SelectItem key={group.id} value={group.id}>
                              <div className="flex items-center gap-2">
                                <GroupTypeIcon type={group.type} />
                                <span>{group.displayName}</span>
                              </div>
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </SimpleConfigRow>
                )}
              </>
            }
            name={name}
            description={description}
            onNameChange={value => setName(value)}
            onDescriptionChange={value => setDescription(value)}
            directAccessRequirement={directAccessRequirement}
            onDirectAccessRequirementChange={setDirectAccessRequirement}
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
            knowledgeDefaultTeamId={knowledgeDefaultTeamId}
            bindModel={bindModel}
            callLimits={{ maxCalls, exemptCalls }}
            onCallLimitsChange={({ maxCalls: nextMax, exemptCalls: nextExempt }) => {
              setMaxCalls(nextMax)
              setExemptCalls(nextExempt)
            }}
            advancedOpen={accordionValue === 'advanced'}
            onAdvancedOpenChange={open => setAccordionValue(open ? 'advanced' : '')}
            retrievalModeSection={
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  {ragModeOptions.map(mode => (
                    <Button
                      key={mode}
                      type="button"
                      variant={ragConfigMode === mode ? 'primary' : 'outline'}
                      className="h-11 min-w-[44px] px-2 text-xs"
                      onClick={() => setRagConfigMode(mode)}
                      data-testid={`rag-mode-${mode}`}
                    >
                      {t(`knowledge:document.ragConfigMode.${mode}`)}
                    </Button>
                  ))}
                </div>
              </div>
            }
            showRetrievalSection={ragConfigMode !== 'disabled'}
            retrievalConfig={retrievalConfig}
            onRetrievalConfigChange={setRetrievalConfig}
            retrievalScope={effectiveScope}
            retrievalGroupName={effectiveGroupName}
            showGuidedQuestions={true}
            guidedQuestions={guidedQuestions}
            onGuidedQuestionsChange={setGuidedQuestions}
          />

          {error && <p className="text-sm text-error">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={loading}
            className="h-11 min-w-[44px]"
            data-testid="cancel-create-kb"
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            variant="primary"
            disabled={loading}
            className="h-11 min-w-[44px]"
            data-testid="submit-create-kb"
          >
            {loading ? t('common:actions.creating') : t('common:actions.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
