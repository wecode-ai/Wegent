// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { UserSearchSelect } from '@/components/common/UserSearchSelect'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import {
  CodeWikiSourceFields,
  useCodeWikiRepository,
  type CodeWikiSourceDraft,
} from '@/features/knowledge/code-wiki/CodeWikiSourceFields'
import type {
  DirectAccessRequirement,
  KnowledgeBaseCreate,
  SummaryModelRef,
  KnowledgeBaseType,
  RetrievalConfigDraft,
  RagConfigMode,
} from '@/types/knowledge'
import type { SearchUser } from '@/types/api'
import { GenerationTaskRow } from '@/features/knowledge/code-wiki/GenerationTaskRow'
import { GenerationStrategySelect } from '@/features/knowledge/code-wiki/GenerationStrategySelect'
import { getKnowledgeBaseRetrievalProfile } from '@/apis/knowledge'
import { KnowledgeBaseForm, useKnowledgeBaseFormNavigation } from './KnowledgeBaseForm'
import { useCreationLocationRefresh } from '../hooks/useCreationLocationRefresh'
import { KnowledgeCreateSpaceSelect } from './KnowledgeCreateSpaceSelect'
import { DingtalkAutoSyncSetting } from './DingtalkAutoSyncSetting'
import { createDefaultRetrievalConfig } from './retrievalConfig'
import { useMultimodalKBConfig } from '@/features/knowledge/multimodal/hooks/useMultimodalKBConfig'

/** Available group for selection */
export interface AvailableGroup {
  id: string
  name: string
  displayName: string
  type: 'personal' | 'group' | 'organization'
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
  spaceName?: string
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
  onRefreshGroups?: () => Promise<void>
  groupsLoading?: boolean
  groupsFailed?: boolean
}

/** Documents are uploaded and organised; code is generated from a repository. */
type KnowledgeBaseKind = 'document' | 'code'

interface RetrievalDraft {
  mode?: RagConfigMode
  config?: RetrievalConfigDraft
  edited?: boolean
}

function createEmptySource(): CodeWikiSourceDraft {
  return {
    mode: 'select',
    repo: null,
    urlInput: '',
    urlSourceType: 'github',
    language: 'zh',
    probe: null,
  }
}

export function CreateKnowledgeBaseDialog({
  open,
  onOpenChange,
  onSubmit,
  loading,
  scope,
  groupName,
  spaceName,
  kbType: initialKbType = 'notebook',
  knowledgeDefaultTeamId,
  bindModel,
  availableGroups,
  defaultGroupId,
  showGroupSelector = false,
  onRefreshGroups,
  groupsLoading = false,
  groupsFailed = false,
}: CreateKnowledgeBaseDialogProps) {
  const { t } = useTranslation('knowledge')
  const locations = useCreationLocationRefresh(open && showGroupSelector, onRefreshGroups)
  const refreshingLocations = groupsLoading || locations.refreshing
  const failedLocations = groupsFailed || locations.failed
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [directAccessRequirement, setDirectAccessRequirement] =
    useState<DirectAccessRequirement>('read')
  const [allowDocumentDownload, setAllowDocumentDownload] = useState<boolean | undefined>()
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
  const [source, setSource] = useState(createEmptySource)
  const repository = useCodeWikiRepository(source)
  const [generationStrategy, setGenerationStrategy] = useState('')
  const [showGenerationTask, setShowGenerationTask] = useState(false)
  const [dingtalkAutoSyncEnabled, setDingtalkAutoSyncEnabled] = useState(false)
  const [scheduledUpdateEnabled, setScheduledUpdateEnabled] = useState(false)
  const [initialCadence, setInitialCadence] = useState<
    'daily' | 'weekly' | 'biweekly' | 'four_weeks' | 'custom'
  >('weekly')
  const [initialIntervalDays, setInitialIntervalDays] = useState(7)
  const [initialWeekday, setInitialWeekday] = useState(0)
  const [initialTime, setInitialTime] = useState('09:00')
  const [initialTimezone, setInitialTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone
  )
  const [initialRunner, setInitialRunner] = useState<SearchUser[]>([])
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
  const [retrievalProfile, setRetrievalProfile] = useState(createDefaultRetrievalConfig)
  const [retrievalDrafts, setRetrievalDrafts] = useState(() => new Map<string, RetrievalDraft>())
  const [error, setError] = useState('')
  const navigation = useKnowledgeBaseFormNavigation()
  const { selectSection } = navigation
  const [maxCalls, setMaxCalls] = useState(10)
  const [exemptCalls, setExemptCalls] = useState(5)
  // Selected group for creating KB (used when showGroupSelector is true)
  const [selectedGroupId, setSelectedGroupId] = useState<string>(defaultGroupId || 'personal')

  // Get the selected group for retrieval scope
  const selectedGroup = availableGroups?.find(g => g.id === selectedGroupId)
  const previousLocation = useRef<AvailableGroup | undefined>(selectedGroup)
  if (selectedGroup) previousLocation.current = selectedGroup
  const retrievalLocation =
    selectedGroup ??
    (previousLocation.current?.id === selectedGroupId ? previousLocation.current : undefined)
  const effectiveScope =
    showGroupSelector && retrievalLocation ? retrievalLocation.type : scope || 'personal'
  const effectiveGroupName =
    showGroupSelector && retrievalLocation && retrievalLocation.type === 'group'
      ? retrievalLocation.name
      : groupName

  // Each draft belongs to the destination where its retrieval resources were selected.
  const retrievalDestination = showGroupSelector
    ? (retrievalLocation?.name ?? selectedGroupId)
    : (effectiveGroupName ?? '')
  const retrievalScopeKey = `${effectiveScope}:${retrievalDestination}`
  const retrievalDraft = retrievalDrafts.get(retrievalScopeKey)
  const ragConfigMode = retrievalDraft?.mode ?? 'auto'
  const retrievalConfig = retrievalDraft?.config ?? retrievalProfile
  const updateRetrievalDraft = useCallback(
    (change: Partial<RetrievalDraft>) => {
      setRetrievalDrafts(drafts =>
        new Map(drafts).set(retrievalScopeKey, { ...drafts.get(retrievalScopeKey), ...change })
      )
    },
    [retrievalScopeKey]
  )
  const setRetrievalConfig = useCallback(
    (config: RetrievalConfigDraft) => updateRetrievalDraft({ config }),
    [updateRetrievalDraft]
  )
  const wasOpen = useRef(false)

  // Reset only on opening, never when a refresh changes default location props.
  useEffect(() => {
    if (open && !wasOpen.current) {
      selectSection('basic')
      setName('')
      setDescription('')
      setSelectedKbType(initialKbType)
      setKind('document')
      setSource(createEmptySource())
      setGenerationStrategy('')
      setShowGenerationTask(false)
      setDingtalkAutoSyncEnabled(false)
      setScheduledUpdateEnabled(false)
      setInitialCadence('weekly')
      setInitialIntervalDays(7)
      setInitialWeekday(0)
      setInitialTime('09:00')
      setInitialTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)
      setInitialRunner([])
      setSelectedGroupId(defaultGroupId || 'personal')
      setDirectAccessRequirement('read')
      setAllowDocumentDownload(true)
      setSummaryEnabled(true)
      setSummaryModelRef(null)
      setSummaryModelError('')
      setExecutionModelRef(null)
      setExecutionModelError('')
      resetMultimodal()
      setGuidedQuestions([])
      setRetrievalProfile(createDefaultRetrievalConfig())
      setRetrievalDrafts(new Map())
      setMaxCalls(10)
      setExemptCalls(5)
      setError('')
    }
    wasOpen.current = open
  }, [open, initialKbType, defaultGroupId, selectSection, resetMultimodal])

  useEffect(() => {
    if (!open) return
    let cancelled = false

    void getKnowledgeBaseRetrievalProfile()
      .then(profile => {
        if (cancelled || profile.health.status !== 'valid' || !profile.retrieval_config) return
        setRetrievalProfile(profile.retrieval_config)
        setRetrievalDrafts(
          drafts =>
            new Map(
              [...drafts].map(([key, draft]) => [key, draft.edited ? draft : { mode: draft.mode }])
            )
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open])

  // Update selectedKbType when KB type changes (keep summaryEnabled unchanged)
  const handleKbTypeChange = (newType: KnowledgeBaseType) => {
    setSelectedKbType(newType)
  }

  const needsLocationVerification = showGroupSelector
    ? selectedGroupId !== 'personal'
    : scope === 'group' || scope === 'organization'
  const locationBlocked = needsLocationVerification && (refreshingLocations || failedLocations)

  const handleSubmit = async () => {
    if (locationBlocked) return
    setError('')
    if (showGroupSelector && (!selectedGroup || !selectedGroup.canCreate)) {
      setError(t('knowledge:document.creation.spaceUnavailable'))
      selectSection('basic', '[data-testid="group-selector"]')
      return
    }
    setSummaryModelError('')
    setExecutionModelError('')
    clearMultimodalError()

    // A code wiki may be left unnamed: the server fills in the repository's own
    // name. Pre-filling the box here instead would read as the caller's own input.
    if (!name.trim() && kind !== 'code') {
      setError(t('knowledge:document.knowledgeBase.nameRequired'))
      selectSection('basic', '#knowledge-name')
      return
    }

    if (kind === 'code' && !repository.url) {
      setError(t('knowledge:codeWiki.create.repositoryRequired'))
      selectSection(
        'basic',
        '[data-testid="code-wiki-source-url"], [data-tour="repo-selector"] [role="combobox"]'
      )
      return
    }

    if (kind === 'code' && !executionModelRef) {
      setExecutionModelError(t('knowledge:codeWiki.create.modelRequired'))
      selectSection('basic', '[data-testid="code-wiki-execution-model-select"]')
      return
    }

    if (
      kind === 'code' &&
      scheduledUpdateEnabled &&
      initialCadence === 'custom' &&
      (!Number.isInteger(initialIntervalDays) ||
        initialIntervalDays < 2 ||
        initialIntervalDays > 365)
    ) {
      setError(t('knowledge:codeWiki.scheduledUpdate.invalidCustomDays'))
      selectSection('generation', '[data-testid="code-wiki-create-custom-days"]')
      return
    }

    if (kind === 'code' && scheduledUpdateEnabled) {
      const [hour, minute] = initialTime.split(':').map(Number)
      if (
        !Number.isInteger(hour) ||
        !Number.isInteger(minute) ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59
      ) {
        setError(t('knowledge:codeWiki.scheduledUpdate.invalidTime'))
        selectSection('generation', '[data-testid="code-wiki-create-time"]')
        return
      }
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

    // Validate call limits
    if (exemptCalls >= maxCalls) {
      setError(t('knowledge:document.callLimits.validationError'))
      selectSection('usage', '#knowledge-exempt-calls [role="slider"]')
      return
    }

    try {
      // Filter out empty guided questions
      const validGuidedQuestions = guidedQuestions.filter(q => q.trim().length > 0)
      await onSubmit({
        name: name.trim(),
        description: description.trim() || undefined,
        direct_access_requirement: directAccessRequirement,
        allow_document_download: allowDocumentDownload,
        retrieval_config:
          ragConfigMode === 'disabled' || !retrievalDraft?.edited ? undefined : retrievalConfig,
        rag_config_mode: ragConfigMode,
        dingtalk_auto_sync_enabled: kind !== 'code' && dingtalkAutoSyncEnabled,
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
              source_type: repository.type,
              source_url: repository.url,
              language: source.language,
              ...(generationStrategy ? { generation_strategy: generationStrategy } : {}),
              show_generation_task: showGenerationTask,
              // Left blank, the repository's own name is used. Sent from what the
              // form already resolved rather than pre-filled into the box, which
              // would read as the caller's own input — and rather than resolved
              // again on the server, which has asked the provider once already.
              resolved_name: repository.resolution?.name,
              resolved_description: repository.resolution?.description,
              execution_model_ref: executionModelRef,
              scheduled_update: scheduledUpdateEnabled
                ? {
                    enabled: true,
                    cadence: initialCadence,
                    interval_days: initialIntervalDays,
                    weekday: initialWeekday,
                    hour: Number(initialTime.split(':')[0]),
                    minute: Number(initialTime.split(':')[1]),
                    timezone: initialTimezone,
                    execution_principal_user_id: initialRunner[0]?.id ?? null,
                  }
                : null,
            }
          : {}),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:error'))
    }
  }

  // Determine if this is a notebook type
  const isNotebook = selectedKbType === 'notebook'
  const ragModeOptions: RagConfigMode[] = ['auto', 'disabled']

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onPointerDownCapture={locations.onReturnInteraction}
        onKeyDownCapture={locations.onReturnInteraction}
        className="w-[calc(100%_-_1rem)] max-w-4xl h-[min(90dvh,46rem)] overflow-hidden flex flex-col"
        closeButtonProps={{
          className: 'right-2 top-2 flex h-11 w-11 items-center justify-center',
          'data-testid': 'close-create-kb',
        }}
        data-testid="create-kb-dialog"
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>{t('knowledge:document.knowledgeBase.create')}</DialogTitle>
          <DialogDescription>
            {t('knowledge:document.knowledgeBase.createDialogDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="shrink-0 space-y-2 empty:hidden">
          {showGroupSelector && (!selectedGroup || !selectedGroup.canCreate) && (
            <div role="alert" className="text-sm text-error">
              {t('knowledge:document.creation.spaceUnavailable')}
              <Button
                type="button"
                variant="outline"
                className="min-h-11 min-w-11"
                data-testid="create-in-personal-space"
                onClick={() => {
                  setSelectedGroupId('personal')
                }}
              >
                {t('knowledge:document.creation.choosePersonal')}
              </Button>
            </div>
          )}
          {refreshingLocations && (
            <p role="status" className="text-sm text-text-muted">
              {t('knowledge:document.creation.refreshingLocations')}
            </p>
          )}
          {failedLocations && (
            <div role="alert" className="text-sm text-error">
              {t('knowledge:document.creation.refreshLocationsFailed')}
              <Button
                type="button"
                variant="outline"
                className="min-h-11 min-w-11"
                data-testid="retry-creation-locations"
                onClick={() => void locations.retry()}
              >
                {t('common:actions.retry')}
              </Button>
            </div>
          )}
        </div>
        <KnowledgeBaseForm
          navigation={navigation}
          kindSection={
            <div className={`grid gap-3 ${kindOptions.length > 1 ? 'sm:grid-cols-2' : ''}`}>
              {kindOptions.map(([option, Icon, label]) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setKind(option)}
                  aria-pressed={kind === option}
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
                  <div className="min-w-0 break-words text-left">
                    <div className="font-medium text-sm">{t(label)}</div>
                    <div className="text-xs text-text-muted">{t(`${label}Desc`)}</div>
                  </div>
                </button>
              ))}
            </div>
          }
          locationSection={
            showGroupSelector && availableGroups && availableGroups.length > 0 ? (
              <SimpleConfigRow
                label={
                  <>
                    {t('knowledge:document.navigation.space')}{' '}
                    <span className="text-red-400">*</span>
                  </>
                }
              >
                <div className="min-w-0 w-full space-y-2">
                  <KnowledgeCreateSpaceSelect
                    spaces={availableGroups}
                    value={selectedGroupId}
                    onValueChange={setSelectedGroupId}
                    onManageOrganizations={locations.onManage}
                    onOpenLocations={locations.onReturnInteraction}
                  />
                  {selectedGroup?.type === 'group' && selectedGroup.canCreate && (
                    <p role="status" className="text-xs text-text-muted">
                      {t('knowledge:document.creation.inheritsTeam')}
                    </p>
                  )}
                </div>
              </SimpleConfigRow>
            ) : (
              <SimpleConfigRow label={t('knowledge:document.navigation.space')}>
                <p className="break-words text-sm text-text-primary">
                  {showGroupSelector
                    ? retrievalLocation?.displayName || t('document.navigation.unknownSpace')
                    : spaceName ||
                      groupName ||
                      t(
                        scope === 'organization'
                          ? 'document.navigation.company'
                          : 'document.navigation.personalSpace'
                      )}
                </p>
              </SimpleConfigRow>
            )
          }
          generationSection={
            kind === 'code' ? (
              <>
                <SimpleConfigRow
                  label={t('knowledge:codeWiki.strategy.label')}
                  description={t('knowledge:codeWiki.strategy.createDescription')}
                >
                  <GenerationStrategySelect
                    value={generationStrategy}
                    onChange={setGenerationStrategy}
                    emptyOption="deployment"
                    testId="code-wiki-generation-strategy"
                  />
                </SimpleConfigRow>
                <SimpleConfigRow
                  label={t('knowledge:codeWiki.create.scheduledUpdate')}
                  description={t('knowledge:codeWiki.create.scheduledUpdateHint')}
                  align="start"
                >
                  <div className="space-y-3">
                    <Switch
                      checked={scheduledUpdateEnabled}
                      onCheckedChange={setScheduledUpdateEnabled}
                      aria-label={t('knowledge:codeWiki.create.scheduledUpdate')}
                      data-testid="code-wiki-create-scheduled-update"
                    />
                    {scheduledUpdateEnabled && (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                          <Select
                            value={initialCadence}
                            onValueChange={value => {
                              const cadence = value as typeof initialCadence
                              setInitialCadence(cadence)
                              const fixed = {
                                daily: 1,
                                weekly: 7,
                                biweekly: 14,
                                four_weeks: 28,
                              }
                              if (cadence !== 'custom') setInitialIntervalDays(fixed[cadence])
                            }}
                          >
                            <SelectTrigger data-testid="code-wiki-create-cadence">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="daily">
                                {t('knowledge:codeWiki.scheduledUpdate.daily')}
                              </SelectItem>
                              <SelectItem value="weekly">
                                {t('knowledge:codeWiki.scheduledUpdate.weekly')}
                              </SelectItem>
                              <SelectItem value="biweekly">
                                {t('knowledge:codeWiki.scheduledUpdate.biweekly')}
                              </SelectItem>
                              <SelectItem value="four_weeks">
                                {t('knowledge:codeWiki.scheduledUpdate.four_weeks')}
                              </SelectItem>
                              <SelectItem value="custom">
                                {t('knowledge:codeWiki.scheduledUpdate.custom')}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          {initialCadence === 'custom' && (
                            <Input
                              type="number"
                              min={2}
                              max={365}
                              value={initialIntervalDays}
                              onChange={event => setInitialIntervalDays(Number(event.target.value))}
                              aria-label={t('knowledge:codeWiki.scheduledUpdate.customDays')}
                              data-testid="code-wiki-create-custom-days"
                            />
                          )}
                          {['weekly', 'biweekly', 'four_weeks'].includes(initialCadence) && (
                            <Select
                              value={String(initialWeekday)}
                              onValueChange={value => setInitialWeekday(Number(value))}
                            >
                              <SelectTrigger data-testid="code-wiki-create-weekday">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {[0, 1, 2, 3, 4, 5, 6].map(day => (
                                  <SelectItem key={day} value={String(day)}>
                                    {t(`knowledge:codeWiki.scheduledUpdate.weekdays.${day}`)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                          <div className="space-y-2">
                            <Label htmlFor="code-wiki-create-time">
                              {t('knowledge:codeWiki.scheduledUpdate.time')}
                            </Label>
                            <Input
                              id="code-wiki-create-time"
                              type="time"
                              value={initialTime}
                              onChange={event => setInitialTime(event.target.value)}
                              data-testid="code-wiki-create-time"
                            />
                          </div>
                        </div>
                        <p
                          className="text-xs text-text-muted"
                          data-testid="code-wiki-create-timezone"
                        >
                          {t('knowledge:codeWiki.scheduledUpdate.timezoneHint', {
                            timezone: initialTimezone,
                          })}
                        </p>
                        <div className="space-y-2">
                          <Label>{t('knowledge:codeWiki.scheduledUpdate.runner')}</Label>
                          <p className="text-xs text-text-secondary">
                            {t('knowledge:codeWiki.scheduledUpdate.runnerHint')}
                          </p>
                          <UserSearchSelect
                            selectedUsers={initialRunner}
                            onSelectedUsersChange={setInitialRunner}
                            multiple={false}
                            placeholder={t('knowledge:codeWiki.scheduledUpdate.runnerPlaceholder')}
                            inputTestId="code-wiki-create-scheduled-runner"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </SimpleConfigRow>
                <GenerationTaskRow checked={showGenerationTask} onChange={setShowGenerationTask} />
              </>
            ) : undefined
          }
          documentSyncSetting={
            kind !== 'code' && (
              <DingtalkAutoSyncSetting
                checked={dingtalkAutoSyncEnabled}
                onCheckedChange={setDingtalkAutoSyncEnabled}
              />
            )
          }
          nameRequired={kind !== 'code'}
          namePlaceholder={
            kind === 'code' ? t('knowledge:codeWiki.create.namePlaceholder') : undefined
          }
          typeSection={
            <>
              {kind === 'code' ? (
                <>
                  <CodeWikiSourceFields
                    value={source}
                    repository={repository}
                    onChange={setSource}
                  />
                  <SimpleConfigRow
                    label={t('knowledge:codeWiki.create.modelLabel')}
                    description={t('knowledge:codeWiki.create.modelDescription')}
                    align="start"
                  >
                    <ModelRefSelector
                      value={executionModelRef}
                      onChange={value => {
                        setExecutionModelRef(value)
                        // Otherwise the "pick a model" error stays beside a field
                        // that now has one, until the next submit clears it.
                        setExecutionModelError('')
                      }}
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
                        className="min-h-11 min-w-11 text-xs text-text-muted hover:text-primary transition-colors"
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
            </>
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
          knowledgeDefaultTeamId={knowledgeDefaultTeamId}
          bindModel={bindModel}
          callLimits={{ maxCalls, exemptCalls }}
          onCallLimitsChange={({ maxCalls: nextMax, exemptCalls: nextExempt }) => {
            setMaxCalls(nextMax)
            setExemptCalls(nextExempt)
          }}
          retrievalModeSection={
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                {ragModeOptions.map(mode => (
                  <Button
                    key={mode}
                    type="button"
                    variant={ragConfigMode === mode ? 'primary' : 'outline'}
                    aria-pressed={ragConfigMode === mode}
                    className="h-11 min-w-[44px] px-2 text-xs"
                    onClick={() => updateRetrievalDraft({ mode })}
                    data-testid={`rag-mode-${mode}`}
                  >
                    {t(`knowledge:document.ragConfigMode.${mode}`)}
                  </Button>
                ))}
              </div>
            </div>
          }
          showRetrievalSection={ragConfigMode !== 'disabled'}
          retrievalScopeKey={retrievalScopeKey}
          retrievalConfig={retrievalConfig}
          onRetrievalConfigChange={setRetrievalConfig}
          onRetrievalConfigUserChange={() => {
            updateRetrievalDraft({ edited: true })
          }}
          retrievalScope={effectiveScope}
          retrievalGroupName={effectiveGroupName}
          showGuidedQuestions={true}
          guidedQuestions={guidedQuestions}
          onGuidedQuestionsChange={setGuidedQuestions}
        />

        {error && (
          <p role="alert" className="shrink-0 text-sm text-error">
            {error}
          </p>
        )}
        <DialogFooter className="shrink-0 flex-row justify-end gap-2 space-y-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
            className="h-11 min-w-[44px]"
            data-testid="cancel-create-kb"
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            variant="primary"
            disabled={
              loading ||
              locationBlocked ||
              (showGroupSelector && (!selectedGroup || !selectedGroup.canCreate))
            }
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
