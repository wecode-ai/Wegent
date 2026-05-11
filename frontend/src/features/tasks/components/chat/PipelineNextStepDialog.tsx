// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { Database, FileText, Loader2, MessageSquare, Table2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/useTranslation'
import {
  buildPipelineNextStepDraft,
  buildPipelineNextStepPayload,
  type PipelineNextStepMessage,
  type PipelineNextStepPayload,
  type PipelineNextStepStructuredItem,
  type PipelineNextStepTextItem,
} from './pipelineNextStep'

interface PipelineNextStepDialogProps {
  open: boolean
  messages: PipelineNextStepMessage[]
  isConfirming: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (payload: PipelineNextStepPayload) => void | Promise<void>
}

const CONTEXT_ICON_CLASS = 'h-4 w-4 text-text-muted'

function getStructuredTestId(item: PipelineNextStepStructuredItem) {
  return `pipeline-next-step-structured-checkbox-${item.context.context_type}-${item.context.id}`
}

function getStructuredIcon(item: PipelineNextStepStructuredItem) {
  if (item.context.context_type === 'knowledge_base') {
    return <Database className={CONTEXT_ICON_CLASS} />
  }

  if (item.context.context_type === 'table') {
    return <Table2 className={CONTEXT_ICON_CLASS} />
  }

  return <FileText className={CONTEXT_ICON_CLASS} />
}

function getPreview(content: string) {
  return content.replace(/\s+/g, ' ').trim()
}

function toggleSelected(current: string[], id: string, checked: boolean) {
  if (checked) {
    return current.includes(id) ? current : [...current, id]
  }

  return current.filter(itemId => itemId !== id)
}

function TextContextRow({
  item,
  label,
  checked,
  onCheckedChange,
}: {
  item: PipelineNextStepTextItem
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-surface px-3 py-2 transition-colors hover:bg-muted/50">
      <Checkbox
        checked={checked}
        onCheckedChange={value => onCheckedChange(value === true)}
        data-testid={`pipeline-next-step-text-checkbox-${item.id}`}
        aria-label={label}
        className="mt-0.5"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <MessageSquare className="h-4 w-4 text-text-muted" />
          {label}
        </span>
        <span className="mt-1 block line-clamp-2 text-xs leading-5 text-text-muted">
          {getPreview(item.content)}
        </span>
      </span>
    </label>
  )
}

function StructuredContextRow({
  item,
  checked,
  onCheckedChange,
}: {
  item: PipelineNextStepStructuredItem
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 transition-colors hover:bg-muted/50">
      <Checkbox
        checked={checked}
        onCheckedChange={value => onCheckedChange(value === true)}
        data-testid={getStructuredTestId(item)}
        aria-label={item.context.name}
      />
      {getStructuredIcon(item)}
      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{item.context.name}</span>
    </label>
  )
}

function PipelineNextStepDialog({
  open,
  messages,
  isConfirming,
  onOpenChange,
  onConfirm,
}: PipelineNextStepDialogProps) {
  const { t } = useTranslation()
  const draft = useMemo(() => buildPipelineNextStepDraft(messages), [messages])
  const [editedMessage, setEditedMessage] = useState('')
  const [selectedTextItemIds, setSelectedTextItemIds] = useState<string[]>([])
  const [selectedStructuredItemIds, setSelectedStructuredItemIds] = useState<string[]>([])

  useEffect(() => {
    if (!open) return

    setEditedMessage(draft.defaultMessage)
    setSelectedTextItemIds(
      draft.textItems.filter(item => item.selectedByDefault).map(item => item.id)
    )
    setSelectedStructuredItemIds(
      draft.structuredItems.filter(item => item.selectedByDefault).map(item => item.id)
    )
  }, [draft, open])

  const hasSelectedContext = selectedTextItemIds.length > 0 || selectedStructuredItemIds.length > 0
  const confirmDisabled = isConfirming || (editedMessage.trim().length === 0 && !hasSelectedContext)

  const handleConfirm = () => {
    if (confirmDisabled) return

    return onConfirm(
      buildPipelineNextStepPayload({
        draft,
        editedMessage,
        selectedTextItemIds,
        selectedStructuredItemIds,
      })
    )
  }

  const setTextItemChecked = (id: string, checked: boolean) => {
    setSelectedTextItemIds(current => toggleSelected(current, id, checked))
  }

  const setStructuredItemChecked = (id: string, checked: boolean) => {
    setSelectedStructuredItemIds(current => toggleSelected(current, id, checked))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[82vh] flex-col gap-4 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('chat:pipeline.next_step_dialog.title')}</DialogTitle>
          <DialogDescription>{t('chat:pipeline.next_step_dialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <div className="space-y-2">
            <div className="text-sm font-medium text-text-primary">
              {t('chat:pipeline.next_step_dialog.message_placeholder')}
            </div>
            <Textarea
              value={editedMessage}
              onChange={event => setEditedMessage(event.target.value)}
              placeholder={t('chat:pipeline.next_step_dialog.message_placeholder')}
              data-testid="pipeline-next-step-message"
              className="min-h-28 resize-none"
            />
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium text-text-primary">
              {t('chat:pipeline.next_step_dialog.text_contexts')}
            </div>
            {draft.textItems.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">
                {t('chat:pipeline.next_step_dialog.no_text_contexts')}
              </div>
            ) : (
              <div className="space-y-2">
                {draft.textItems.map(item => (
                  <TextContextRow
                    key={item.id}
                    item={item}
                    label={t(`chat:pipeline.next_step_dialog.text_items.${item.kind}`)}
                    checked={selectedTextItemIds.includes(item.id)}
                    onCheckedChange={checked => setTextItemChecked(item.id, checked)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium text-text-primary">
              {t('chat:pipeline.next_step_dialog.structured_contexts')}
            </div>
            {draft.structuredItems.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">
                {t('chat:pipeline.next_step_dialog.no_structured_contexts')}
              </div>
            ) : (
              <div className="space-y-2">
                {draft.structuredItems.map(item => (
                  <StructuredContextRow
                    key={item.id}
                    item={item}
                    checked={selectedStructuredItemIds.includes(item.id)}
                    onCheckedChange={checked => setStructuredItemChecked(item.id, checked)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 pt-1 sm:space-x-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="pipeline-next-step-cancel-button"
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleConfirm}
            disabled={confirmDisabled}
            data-testid="pipeline-next-step-confirm-button"
          >
            {isConfirming && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isConfirming
              ? t('chat:pipeline.next_step_dialog.confirming')
              : t('chat:pipeline.next_step_dialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default PipelineNextStepDialog
