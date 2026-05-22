// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo } from 'react'
import { ArrowRightLeft } from 'lucide-react'
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
import { Spinner } from '@/components/ui/spinner'
import { getOrganizationNamespace, listKnowledgeBases } from '@/apis/knowledge'
import type { KnowledgeBase } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'
import { toast } from '@/hooks/use-toast'

interface TransferToKbDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Number of selected documents to transfer */
  selectedDocumentCount: number
  /** Number of selected folders to transfer */
  selectedFolderCount: number
  /** Current knowledge base ID (excluded from target list) */
  currentKnowledgeBaseId: number
  /** Current knowledge base namespace used to filter allowed target namespaces */
  currentKnowledgeBaseNamespace: string
  /** Callback when user confirms the transfer */
  onConfirm: (targetKbId: number) => Promise<void>
  /** Whether the transfer operation is in progress */
  isSubmitting?: boolean
  /** Progress text shown while a transfer is running */
  progressText?: string
}
/**
 * Group knowledge bases by their namespace for display
 * - namespace === 'default' -> personal KB
 * - other namespaces -> team/organization KB (we treat them as "team" for simplicity)
 */
type KnowledgeNamespaceScope = 'personal' | 'group' | 'organization'

const TRANSFER_ALLOWED_TARGET_SCOPES: Record<
  KnowledgeNamespaceScope,
  Set<KnowledgeNamespaceScope>
> = {
  personal: new Set(['personal', 'group', 'organization']),
  group: new Set(['personal', 'group', 'organization']),
  organization: new Set(['organization']),
}

function getNamespaceScope(
  namespace: string,
  organizationNamespace: string | null
): KnowledgeNamespaceScope {
  if (namespace === 'default') return 'personal'
  if (organizationNamespace && namespace === organizationNamespace) return 'organization'
  return 'group'
}

function canTransferToNamespace(
  sourceNamespace: string,
  targetNamespace: string,
  organizationNamespace: string | null
): boolean {
  const sourceScope = getNamespaceScope(sourceNamespace, organizationNamespace)
  const targetScope = getNamespaceScope(targetNamespace, organizationNamespace)
  return TRANSFER_ALLOWED_TARGET_SCOPES[sourceScope]?.has(targetScope) ?? false
}

function groupKnowledgeBases(kbs: KnowledgeBase[], organizationNamespace: string | null) {
  const personal: KnowledgeBase[] = []
  const team: KnowledgeBase[] = []
  const organization: KnowledgeBase[] = []

  for (const kb of kbs) {
    const scope = getNamespaceScope(kb.namespace, organizationNamespace)
    if (scope === 'personal') {
      personal.push(kb)
    } else if (scope === 'organization') {
      organization.push(kb)
    } else {
      team.push(kb)
    }
  }

  return { personal, team, organization }
}

export function TransferToKbDialog({
  open,
  onOpenChange,
  selectedDocumentCount,
  selectedFolderCount,
  currentKnowledgeBaseId,
  currentKnowledgeBaseNamespace,
  onConfirm,
  isSubmitting = false,
  progressText,
}: TransferToKbDialogProps) {
  const { t } = useTranslation('knowledge')
  const [targetKbId, setTargetKbId] = useState<string>('')
  const [allKbs, setAllKbs] = useState<KnowledgeBase[]>([])
  const [organizationNamespace, setOrganizationNamespace] = useState<string | null>(null)
  const [loadingKbs, setLoadingKbs] = useState(false)

  // Fetch all KBs when dialog opens (personal, team, organization)
  useEffect(() => {
    if (open) {
      setLoadingKbs(true)
      Promise.all([listKnowledgeBases('all'), getOrganizationNamespace()])
        .then(([res, org]) => {
          const orgNamespace = org.namespace
          setOrganizationNamespace(orgNamespace)
          setAllKbs(
            res.items.filter(
              kb =>
                kb.id !== currentKnowledgeBaseId &&
                canTransferToNamespace(currentKnowledgeBaseNamespace, kb.namespace, orgNamespace)
            )
          )
        })
        .catch(() => {
          setAllKbs([])
          toast({
            title: t('document.document.batch.transferFailed'),
            variant: 'destructive',
          })
        })
        .finally(() => setLoadingKbs(false))
    }
  }, [open, currentKnowledgeBaseId, currentKnowledgeBaseNamespace, t])

  // Clear targetKbId when dialog closes (handles both UI interaction and parent prop change)
  useEffect(() => {
    if (!open) {
      setTargetKbId('')
    }
  }, [open])

  // Group KBs by type
  const groupedKbs = useMemo(
    () => groupKnowledgeBases(allKbs, organizationNamespace),
    [allKbs, organizationNamespace]
  )
  const hasKbs = allKbs.length > 0

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setTargetKbId('')
    }
    onOpenChange(newOpen)
  }

  const handleTransfer = async () => {
    if (!targetKbId) return
    await onConfirm(Number(targetKbId))
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="w-5 h-5 text-primary" />
            {t('document.document.batch.transferTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="py-4 space-y-4">
          <p className="text-sm text-text-secondary">
            {t('document.document.batch.transferHint', {
              docCount: selectedDocumentCount,
              folderCount: selectedFolderCount,
            })}
          </p>

          {/* Target KB selector */}
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">
              {t('document.document.batch.selectTargetKb')}
            </Label>
            {loadingKbs ? (
              <div className="flex items-center justify-center py-3">
                <Spinner />
              </div>
            ) : !hasKbs ? (
              <p className="text-sm text-text-muted py-2">
                {t('document.document.batch.noOtherKbs')}
              </p>
            ) : (
              <Select value={targetKbId} onValueChange={setTargetKbId}>
                <SelectTrigger className="h-9" data-testid="transfer-target-kb-select">
                  <SelectValue placeholder={t('document.document.batch.selectTargetKb')} />
                </SelectTrigger>
                <SelectContent>
                  {/* Personal KBs */}
                  {groupedKbs.personal.length > 0 && (
                    <>
                      <SelectItem
                        value="__personal_group__"
                        disabled
                        className="font-semibold text-text-secondary"
                      >
                        {t('knowledgeBase.personal')}
                      </SelectItem>
                      {groupedKbs.personal.map(kb => (
                        <SelectItem key={kb.id} value={String(kb.id)}>
                          {kb.name}
                        </SelectItem>
                      ))}
                    </>
                  )}

                  {/* Team KBs */}
                  {groupedKbs.team.length > 0 && (
                    <>
                      <SelectItem
                        value="__team_group__"
                        disabled
                        className="font-semibold text-text-secondary"
                      >
                        {t('knowledgeBase.team')}
                      </SelectItem>
                      {groupedKbs.team.map(kb => (
                        <SelectItem key={kb.id} value={String(kb.id)}>
                          {kb.namespace !== 'default' ? `${kb.namespace} / ${kb.name}` : kb.name}
                        </SelectItem>
                      ))}
                    </>
                  )}

                  {/* Organization KBs */}
                  {groupedKbs.organization.length > 0 && (
                    <>
                      <SelectItem
                        value="__organization_group__"
                        disabled
                        className="font-semibold text-text-secondary"
                      >
                        {t('knowledgeBase.organization')}
                      </SelectItem>
                      {groupedKbs.organization.map(kb => (
                        <SelectItem key={kb.id} value={String(kb.id)}>
                          {kb.namespace} / {kb.name}
                        </SelectItem>
                      ))}
                    </>
                  )}
                </SelectContent>
              </Select>
            )}
          </div>
          {isSubmitting && progressText && (
            <div className="flex items-center gap-2 rounded-md bg-primary/5 px-3 py-2 text-sm text-primary">
              <Spinner />
              <span>{progressText}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isSubmitting}
            className="h-11 min-w-[44px]"
            data-testid="transfer-cancel-button"
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleTransfer}
            disabled={isSubmitting || !targetKbId || loadingKbs || !hasKbs}
            className="h-11 min-w-[44px]"
            data-testid="transfer-confirm-button"
          >
            {isSubmitting
              ? t('document.document.batch.transferring')
              : t('document.document.batch.transfer')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
