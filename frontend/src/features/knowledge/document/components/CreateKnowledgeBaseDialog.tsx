// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { BookOpen, Database, User, Building2, Users } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import type { SummaryModelRef, KnowledgeBaseType, RetrievalConfig } from '@/types/knowledge'
import { KnowledgeBaseForm } from './KnowledgeBaseForm'

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
  onSubmit: (data: {
    name: string
    description?: string
    retrieval_config?: Partial<RetrievalConfig>
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
  /** Available groups for selection (for "All" mode) */
  availableGroups?: AvailableGroup[]
  /** Default selected group ID */
  defaultGroupId?: string
  /** Whether to show group selector (true when creating from "All" page) */
  showGroupSelector?: boolean
}

/** Get icon for group type */
function GroupTypeIcon({ type }: { type: 'personal' | 'group' | 'organization' }) {
  switch (type) {
    case 'personal':
      return <User className="w-4 h-4" />
    case 'organization':
      return <Building2 className="w-4 h-4" />
    case 'group':
    default:
      return <Users className="w-4 h-4" />
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
  availableGroups,
  defaultGroupId,
  showGroupSelector = false,
}: CreateKnowledgeBaseDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  // Selected KB type (can be changed by user)
  const [selectedKbType, setSelectedKbType] = useState<KnowledgeBaseType>(initialKbType)
  // Default enable summary for notebook type, disable for classic type
  const [summaryEnabled, setSummaryEnabled] = useState(initialKbType === 'notebook')
  const [summaryModelRef, setSummaryModelRef] = useState<SummaryModelRef | null>(null)
  const [summaryModelError, setSummaryModelError] = useState('')
  const [guidedQuestions, setGuidedQuestions] = useState<string[]>([])
  const [retrievalConfig, setRetrievalConfig] = useState<Partial<RetrievalConfig>>({
    retrieval_mode: 'vector',
    top_k: 5,
    score_threshold: 0.5,
    hybrid_weights: {
      vector_weight: 0.7,
      keyword_weight: 0.3,
    },
  })
  const [error, setError] = useState('')
  const [accordionValue, setAccordionValue] = useState<string>('')
  const [maxCalls, setMaxCalls] = useState(10)
  const [exemptCalls, setExemptCalls] = useState(5)
  // Selected group for creating KB (used when showGroupSelector is true)
  const [selectedGroupId, setSelectedGroupId] = useState<string>(defaultGroupId || 'personal')

  // Reset summaryEnabled, selectedKbType and selectedGroupId when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedKbType(initialKbType)
      setSummaryEnabled(initialKbType === 'notebook')
      setSelectedGroupId(defaultGroupId || 'personal')
    }
  }, [open, initialKbType, defaultGroupId])

  // Update summaryEnabled when KB type changes
  const handleKbTypeChange = (newType: KnowledgeBaseType) => {
    setSelectedKbType(newType)
    setSummaryEnabled(newType === 'notebook')
  }

  // Note: Auto-selection of retriever and embedding model is handled by RetrievalSettingsSection

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

    // Note: retrieval_config is now optional - users can create KB without RAG
    // AI will use kb_ls/kb_head tools to explore documents instead of RAG search

    try {
      // Filter out empty guided questions
      const validGuidedQuestions = guidedQuestions.filter(q => q.trim().length > 0)
      await onSubmit({
        name: name.trim(),
        description: description.trim() || undefined,
        retrieval_config: retrievalConfig,
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
      // Reset selectedKbType and summaryEnabled based on initialKbType
      setSelectedKbType(initialKbType)
      setSummaryEnabled(initialKbType === 'notebook')
      setSummaryModelRef(null)
      setGuidedQuestions([])
      setRetrievalConfig({
        retrieval_mode: 'vector',
        top_k: 5,
        score_threshold: 0.5,
        hybrid_weights: {
          vector_weight: 0.7,
          keyword_weight: 0.3,
        },
      })
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
      // Reset selectedKbType and summaryEnabled based on initialKbType
      setSelectedKbType(initialKbType)
      setSummaryEnabled(initialKbType === 'notebook')
      setSummaryModelRef(null)
      setSummaryModelError('')
      setGuidedQuestions([])
      setRetrievalConfig({
        retrieval_mode: 'vector',
        top_k: 5,
        score_threshold: 0.5,
        hybrid_weights: {
          vector_weight: 0.7,
          keyword_weight: 0.3,
        },
      })
      setMaxCalls(10)
      setExemptCalls(5)
      setError('')
      setAccordionValue('')
      setSelectedGroupId(defaultGroupId || 'personal')
    }
    onOpenChange(newOpen)
  }

  // Get the selected group for retrieval scope
  const selectedGroup = availableGroups?.find(g => g.id === selectedGroupId)
  const effectiveScope = showGroupSelector && selectedGroup ? selectedGroup.type : scope
  const effectiveGroupName =
    showGroupSelector && selectedGroup && selectedGroup.type === 'group'
      ? selectedGroup.name
      : groupName

  // Determine if this is a notebook type
  const isNotebook = selectedKbType === 'notebook'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        data-testid="create-kb-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('knowledge:document.knowledgeBase.create')}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-4 py-4">
          <KnowledgeBaseForm
            typeSection={
              <>
                {/* KB Type selector - subtle style */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>{t('knowledge:document.knowledgeBase.type')}</Label>
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
                        isNotebook ? 'bg-primary/10 text-primary' : 'bg-surface text-text-secondary'
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
                {/* Group selector - only show when showGroupSelector is true */}
                {showGroupSelector && availableGroups && availableGroups.length > 0 && (
                  <div className="space-y-2 mt-4">
                    <Label>{t('knowledge:document.knowledgeBase.targetGroup', '归属分组')} *</Label>
                    <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
                      <SelectTrigger data-testid="group-selector">
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
                  </div>
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
            callLimits={{ maxCalls, exemptCalls }}
            onCallLimitsChange={({ maxCalls: nextMax, exemptCalls: nextExempt }) => {
              setMaxCalls(nextMax)
              setExemptCalls(nextExempt)
            }}
            advancedVariant="accordion"
            advancedOpen={accordionValue === 'advanced'}
            onAdvancedOpenChange={open => setAccordionValue(open ? 'advanced' : '')}
            advancedDescription={t('knowledge:document.advancedSettings.collapsed')}
            showRetrievalSection={true}
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
