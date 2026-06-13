// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { BookOpen, Database, User, Building2, Users, FileText } from 'lucide-react'
import {
  Dialog,
  DialogContent,
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
import type {
  SummaryModelRef,
  KnowledgeBaseType,
  RetrievalConfigDraft,
  RagConfigMode,
} from '@/types/knowledge'
import { KnowledgeBaseForm } from './KnowledgeBaseForm'

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
  onSubmit: (data: {
    name: string
    description?: string
    retrieval_config?: RetrievalConfigDraft
    rag_config_mode?: RagConfigMode
    summary_enabled?: boolean
    summary_model_ref?: SummaryModelRef | null
    guided_questions?: string[]
    max_calls_per_conversation: number
    exempt_calls_before_check: number
    /** Selected group ID for creating the KB */
    selectedGroupId?: string
    /** Knowledge base type selected by user */
    kb_type: KnowledgeBaseType
  }) => Promise<void>
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
  // Selected KB type (can be changed by user)
  const [selectedKbType, setSelectedKbType] = useState<KnowledgeBaseType>(initialKbType)
  // Default enable summary for all KB types
  const [summaryEnabled, setSummaryEnabled] = useState(true)
  const [summaryModelRef, setSummaryModelRef] = useState<SummaryModelRef | null>(null)
  const [summaryModelError, setSummaryModelError] = useState('')
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
      setSelectedGroupId(defaultGroupId || 'personal')
    }
  }, [open, initialKbType, defaultGroupId])

  // Update selectedKbType when KB type changes (keep summaryEnabled unchanged)
  const handleKbTypeChange = (newType: KnowledgeBaseType) => {
    setSelectedKbType(newType)
  }

  const handleSubmit = async () => {
    setError('')
    setSummaryModelError('')

    if (!name.trim()) {
      setError(t('knowledge:document.knowledgeBase.nameRequired'))
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
        retrieval_config: ragConfigMode === 'disabled' ? undefined : retrievalConfig,
        rag_config_mode: ragConfigMode,
        summary_enabled: summaryEnabled,
        summary_model_ref: summaryEnabled ? summaryModelRef : null,
        guided_questions:
          selectedKbType === 'notebook' && validGuidedQuestions.length > 0
            ? validGuidedQuestions
            : undefined,
        max_calls_per_conversation: maxCalls,
        exempt_calls_before_check: exemptCalls,
        selectedGroupId: showGroupSelector ? selectedGroupId : undefined,
        kb_type: selectedKbType,
      })
      setName('')
      setDescription('')
      // Reset selectedKbType and keep summaryEnabled as true
      setSelectedKbType(initialKbType)
      setSummaryEnabled(true)
      setSummaryModelRef(null)
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
      // Reset selectedKbType and keep summaryEnabled as true
      setSelectedKbType(initialKbType)
      setSummaryEnabled(true)
      setSummaryModelRef(null)
      setSummaryModelError('')
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
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-4 py-4 pr-3 [scrollbar-gutter:stable]">
          <KnowledgeBaseForm
            typeSection={
              <>
                {/* KB Type selector - subtle style */}
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
            showGuidedQuestions={isNotebook}
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
