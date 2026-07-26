// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { ApiError } from '@/apis/client'
import { createTextKnowledgeDocument } from '@/apis/knowledge'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useUser } from '@/features/common/UserContext'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  AllGroupedKnowledgeResponse,
  KnowledgeBaseWithGroupInfo,
  KnowledgeDocument,
} from '@/types/knowledge'
import { canManageKnowledgeBaseDocuments } from '@/utils/namespace-permissions'

const WysiwygEditor = dynamic(
  () => import('@/components/common/WysiwygEditor').then(module => module.WysiwygEditor),
  { ssr: false }
)

const MAX_TITLE_LENGTH = 255
const MAX_CONTENT_LENGTH = 500_000

interface WritableKnowledgeBaseOption {
  knowledgeBase: KnowledgeBaseWithGroupInfo
  scopeLabel: string
}

export interface SaveToKnowledgeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTitle: string
  initialContent: string
  defaultKnowledgeBaseId?: number
  onCreated: (document: KnowledgeDocument, knowledgeBase: KnowledgeBaseWithGroupInfo) => void
}

function flattenKnowledgeBases(data: AllGroupedKnowledgeResponse): KnowledgeBaseWithGroupInfo[] {
  return [
    ...data.personal.created_by_me,
    ...data.personal.shared_with_me,
    ...data.groups.flatMap(group => group.knowledge_bases),
    ...data.organization.knowledge_bases,
  ]
}

export function getWritableKnowledgeBases(
  data: AllGroupedKnowledgeResponse,
  currentUserId: number,
  getScopeLabel: (knowledgeBase: KnowledgeBaseWithGroupInfo) => string
): WritableKnowledgeBaseOption[] {
  const seen = new Set<number>()
  return flattenKnowledgeBases(data)
    .filter(knowledgeBase => {
      if (seen.has(knowledgeBase.id)) return false
      seen.add(knowledgeBase.id)
      return canManageKnowledgeBaseDocuments({
        currentUserId,
        knowledgeBase,
        knowledgeRole: knowledgeBase.my_role,
      })
    })
    .map(knowledgeBase => ({
      knowledgeBase,
      scopeLabel: getScopeLabel(knowledgeBase),
    }))
}

export function SaveToKnowledgeDialog({
  open,
  onOpenChange,
  initialTitle,
  initialContent,
  defaultKnowledgeBaseId,
  onCreated,
}: SaveToKnowledgeDialogProps) {
  const { t } = useTranslation('chat')
  const { user } = useUser()
  const [title, setTitle] = useState(initialTitle)
  const [content, setContent] = useState(initialContent)
  const [selectedKnowledgeBaseId, setSelectedKnowledgeBaseId] = useState<string>()
  const [options, setOptions] = useState<WritableKnowledgeBaseOption[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [submitError, setSubmitError] = useState<string>()
  const [defaultKnowledgeBaseReadOnly, setDefaultKnowledgeBaseReadOnly] = useState(false)

  const getScopeLabel = useCallback(
    (knowledgeBase: KnowledgeBaseWithGroupInfo) => {
      if (knowledgeBase.group_type === 'personal') {
        return t('saveToKnowledge.scope.personal')
      }
      if (knowledgeBase.group_type === 'personal-shared') {
        return t('saveToKnowledge.scope.shared')
      }
      return knowledgeBase.group_name
    },
    [t]
  )

  const loadKnowledgeBases = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setLoadError(false)
    try {
      const data = await knowledgeBaseApi.getAllGrouped()
      const nextOptions = getWritableKnowledgeBases(data, user.id, getScopeLabel)
      setOptions(nextOptions)

      const defaultIsWritable =
        defaultKnowledgeBaseId !== undefined &&
        nextOptions.some(option => option.knowledgeBase.id === defaultKnowledgeBaseId)
      setSelectedKnowledgeBaseId(defaultIsWritable ? String(defaultKnowledgeBaseId) : undefined)
      setDefaultKnowledgeBaseReadOnly(
        defaultKnowledgeBaseId !== undefined &&
          flattenKnowledgeBases(data).some(kb => kb.id === defaultKnowledgeBaseId) &&
          !defaultIsWritable
      )
    } catch {
      setOptions([])
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [defaultKnowledgeBaseId, getScopeLabel, user])

  useEffect(() => {
    if (!open) return
    setTitle(initialTitle)
    setContent(initialContent)
    setSelectedKnowledgeBaseId(undefined)
    setSubmitError(undefined)
    setDefaultKnowledgeBaseReadOnly(false)
    void loadKnowledgeBases()
  }, [initialContent, initialTitle, loadKnowledgeBases, open])

  const selectedOption = useMemo(
    () => options.find(option => String(option.knowledgeBase.id) === selectedKnowledgeBaseId),
    [options, selectedKnowledgeBaseId]
  )

  const trimmedTitle = title.trim()
  const trimmedContent = content.trim()
  const isValid =
    Boolean(selectedOption) &&
    trimmedTitle.length > 0 &&
    trimmedTitle.length <= MAX_TITLE_LENGTH &&
    trimmedContent.length > 0 &&
    content.length <= MAX_CONTENT_LENGTH

  const handleSubmit = async () => {
    if (!selectedOption || !isValid) return
    setSubmitting(true)
    setSubmitError(undefined)
    try {
      const document = await createTextKnowledgeDocument({
        knowledge_base_id: selectedOption.knowledgeBase.id,
        name: trimmedTitle,
        content,
      })
      onCreated(document, selectedOption.knowledgeBase)
      onOpenChange(false)
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setSelectedKnowledgeBaseId(undefined)
        setSubmitError(t('saveToKnowledge.errors.permissionChanged'))
      } else if (error instanceof ApiError && error.status === 404) {
        setSelectedKnowledgeBaseId(undefined)
        setSubmitError(t('saveToKnowledge.errors.targetMissing'))
        void loadKnowledgeBases()
      } else if (error instanceof ApiError && error.status === 422) {
        setSubmitError(t('saveToKnowledge.errors.invalidContent'))
      } else {
        setSubmitError(t('saveToKnowledge.errors.saveFailed'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90vh] w-[calc(100vw-2rem)] max-w-4xl flex-col"
        data-testid="save-to-knowledge-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('saveToKnowledge.title')}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-y-auto py-2">
          <div className="space-y-1.5">
            <Label htmlFor="save-to-knowledge-target">{t('saveToKnowledge.targetLabel')}</Label>
            <Select
              value={selectedKnowledgeBaseId}
              onValueChange={setSelectedKnowledgeBaseId}
              disabled={loading || options.length === 0}
            >
              <SelectTrigger
                id="save-to-knowledge-target"
                className="h-11"
                data-testid="save-to-knowledge-target-select"
              >
                <SelectValue placeholder={t('saveToKnowledge.targetPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {options.map(option => (
                  <SelectItem
                    key={option.knowledgeBase.id}
                    value={String(option.knowledgeBase.id)}
                    data-testid={`save-to-knowledge-target-option-${option.knowledgeBase.id}`}
                  >
                    {option.scopeLabel} / {option.knowledgeBase.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {loading && (
              <p className="flex items-center gap-2 text-sm text-text-secondary">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('saveToKnowledge.loadingTargets')}
              </p>
            )}
            {!loading && loadError && (
              <p className="text-sm text-error">{t('saveToKnowledge.errors.loadFailed')}</p>
            )}
            {!loading && !loadError && options.length === 0 && (
              <p className="text-sm text-text-secondary">
                {t('saveToKnowledge.noWritableTargets')}
              </p>
            )}
            {defaultKnowledgeBaseReadOnly && (
              <p className="text-sm text-warning">{t('saveToKnowledge.currentTargetReadOnly')}</p>
            )}
            {selectedOption && (
              <p className="text-sm text-text-secondary">
                {t('saveToKnowledge.permissionHint', {
                  name: selectedOption.knowledgeBase.name,
                })}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="save-to-knowledge-title">
              {t('saveToKnowledge.documentTitleLabel')}
            </Label>
            <Input
              id="save-to-knowledge-title"
              value={title}
              onChange={event => setTitle(event.target.value)}
              maxLength={MAX_TITLE_LENGTH}
              data-testid="save-to-knowledge-title-input"
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('saveToKnowledge.contentLabel')}</Label>
            <div data-testid="save-to-knowledge-content-editor">
              <WysiwygEditor
                initialContent={initialContent}
                onChange={setContent}
                className="min-h-[320px]"
                language="markdown"
              />
            </div>
            <p className="text-right text-xs text-text-tertiary">
              {t('saveToKnowledge.contentLength', {
                current: content.length,
                max: MAX_CONTENT_LENGTH,
              })}
            </p>
          </div>

          {submitError && (
            <p className="text-sm text-error" role="alert">
              {submitError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            data-testid="save-to-knowledge-cancel-button"
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="primary"
            className="min-h-11"
            onClick={handleSubmit}
            disabled={!isValid || submitting || loading}
            data-testid="save-to-knowledge-submit-button"
          >
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {submitting ? t('saveToKnowledge.saving') : t('saveToKnowledge.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
