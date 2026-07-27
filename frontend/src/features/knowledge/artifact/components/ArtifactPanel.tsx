// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ChevronRight, FileText, Network } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { ArtifactCreateDialog } from './ArtifactCreateDialog'
import { ArtifactCard } from './ArtifactCard'
import { ArtifactViewer } from './ArtifactViewer'
import { useKnowledgeArtifacts } from '../hooks/useKnowledgeArtifacts'
import type { ArtifactPromptRequest, KnowledgeArtifactType } from '@/types/knowledge-artifact'

interface ArtifactPanelProps {
  knowledgeBaseId: number
  selectedDocumentIds: number[]
  onAdjustSources: (onApplied?: () => void) => void
  onAvailableDocumentCountChange?: (count: number | null) => void
  onProcessingDocumentCountChange?: (count: number) => void
  onCanManageChange?: (canManage: boolean) => void
  onAskNode?: (request: ArtifactPromptRequest) => void
}

export function ArtifactPanel({
  knowledgeBaseId,
  selectedDocumentIds,
  onAdjustSources,
  onAvailableDocumentCountChange,
  onProcessingDocumentCountChange,
  onCanManageChange,
  onAskNode,
}: ArtifactPanelProps) {
  const { t } = useTranslation('knowledge')
  const { toast } = useToast()
  const {
    items,
    canManage,
    availableDocumentCount,
    processingDocumentCount,
    isLoading,
    error,
    create,
    rename,
    retry,
    remove,
    refresh,
  } = useKnowledgeArtifacts(knowledgeBaseId)
  const [createOpen, setCreateOpen] = useState(false)
  const [createType, setCreateType] = useState<KnowledgeArtifactType>('briefing')
  const [createSessionKey, setCreateSessionKey] = useState(0)
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const [pendingDeleteArtifactId, setPendingDeleteArtifactId] = useState<string | null>(null)
  const selectedArtifact = useMemo(
    () => items.find(item => item.artifact_id === selectedArtifactId) ?? null,
    [items, selectedArtifactId]
  )
  const effectiveAvailableDocumentCount = availableDocumentCount ?? 0

  useEffect(() => {
    onAvailableDocumentCountChange?.(availableDocumentCount)
  }, [availableDocumentCount, onAvailableDocumentCountChange])

  useEffect(() => {
    if (isLoading || error) return
    onProcessingDocumentCountChange?.(processingDocumentCount)
    onCanManageChange?.(canManage)
  }, [
    canManage,
    error,
    isLoading,
    onCanManageChange,
    onProcessingDocumentCountChange,
    processingDocumentCount,
  ])

  const showError = (nextError: unknown) => {
    toast({
      description: nextError instanceof Error ? nextError.message : t('artifact.operationFailed'),
      variant: 'destructive',
    })
  }

  const deleteArtifact = async (artifactId: string) => {
    try {
      await remove(artifactId)
      if (selectedArtifactId === artifactId) {
        setSelectedArtifactId(null)
      }
    } catch (nextError) {
      showError(nextError)
    }
  }

  const openCreate = (artifactType: KnowledgeArtifactType) => {
    setCreateType(artifactType)
    setCreateSessionKey(current => current + 1)
    setCreateOpen(true)
  }

  return (
    <div className="flex h-full flex-col" data-testid="artifact-panel">
      {canManage && (
        <div className="mb-5">
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              className="group flex min-h-24 flex-col justify-between rounded-xl border border-border bg-surface p-3 text-left transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
              onClick={() => openCreate('briefing')}
              disabled={effectiveAvailableDocumentCount === 0}
              data-testid="artifact-type-briefing"
            >
              <div className="flex w-full items-center justify-between">
                <div className="rounded-lg bg-primary/10 p-2 text-primary transition-colors group-hover:bg-primary group-hover:text-white">
                  <FileText className="h-5 w-5" />
                </div>
                <div className="rounded-full bg-base p-2 text-text-muted transition-colors group-hover:text-primary">
                  <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </div>
              </div>
              <div className="mt-2 text-sm font-medium leading-5">
                {t('artifact.action.briefing')}
              </div>
            </button>
            <button
              type="button"
              className="group flex min-h-24 flex-col justify-between rounded-xl border border-border bg-surface p-3 text-left transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
              onClick={() => openCreate('mind_map')}
              disabled={effectiveAvailableDocumentCount === 0}
              data-testid="artifact-type-mind-map"
            >
              <div className="flex w-full items-center justify-between">
                <div className="rounded-lg bg-primary/10 p-2 text-primary transition-colors group-hover:bg-primary group-hover:text-white">
                  <Network className="h-5 w-5" />
                </div>
                <div className="rounded-full bg-base p-2 text-text-muted transition-colors group-hover:text-primary">
                  <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </div>
              </div>
              <div className="mt-2 text-sm font-medium leading-5">
                {t('artifact.action.mind_map')}
              </div>
            </button>
          </div>
          {!isLoading && !error && effectiveAvailableDocumentCount === 0 && (
            <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-text-secondary">
              {t(
                processingDocumentCount > 0
                  ? 'artifact.documentsProcessingHint'
                  : 'artifact.noDocumentsHint'
              )}
            </p>
          )}
        </div>
      )}

      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('artifact.recentGenerations')}</h3>
        {items.some(item => item.status === 'queued' || item.status === 'running') && (
          <span className="text-xs text-text-secondary">
            {t('artifact.runningCount', {
              count: items.filter(item => item.status === 'queued' || item.status === 'running')
                .length,
            })}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : error && items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <AlertCircle className="mb-2 h-8 w-8 text-error" />
          <p className="text-sm text-text-secondary">{t('artifact.loadFailed')}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void refresh(true)}
            data-testid="artifact-refresh-button"
          >
            {t('artifact.retry')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-border px-5 py-8 text-center">
          <p className="text-sm font-medium">{t('artifact.empty')}</p>
          <p className="mt-1 text-xs text-text-secondary">
            {t(canManage ? 'artifact.emptyHint' : 'artifact.emptyReadOnlyHint')}
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-auto pb-4">
          {items.map(artifact => (
            <ArtifactCard
              key={artifact.artifact_id}
              artifact={artifact}
              onOpen={() => setSelectedArtifactId(artifact.artifact_id)}
              onDelete={() => setPendingDeleteArtifactId(artifact.artifact_id)}
            />
          ))}
        </div>
      )}
      <AlertDialog
        open={pendingDeleteArtifactId !== null}
        onOpenChange={open => !open && setPendingDeleteArtifactId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('artifact.delete')}</AlertDialogTitle>
            <AlertDialogDescription>{t('artifact.deleteConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('artifact.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="artifact-delete-confirm"
              onClick={() => {
                if (!pendingDeleteArtifactId) return
                const artifactId = pendingDeleteArtifactId
                setPendingDeleteArtifactId(null)
                void deleteArtifact(artifactId)
              }}
            >
              {t('artifact.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {canManage && (
        <ArtifactCreateDialog
          key={createSessionKey}
          open={createOpen}
          onOpenChange={setCreateOpen}
          artifactType={createType}
          selectedDocumentIds={selectedDocumentIds}
          knowledgeBaseDocumentCount={effectiveAvailableDocumentCount}
          onAdjustSources={() => {
            setCreateOpen(false)
            onAdjustSources(() => setCreateOpen(true))
          }}
          onCreate={async request => {
            try {
              await create(request)
              toast({ description: t('artifact.started') })
            } catch (nextError) {
              showError(nextError)
              throw nextError
            }
          }}
        />
      )}
      <ArtifactViewer
        artifact={selectedArtifact}
        canManage={canManage}
        onClose={() => setSelectedArtifactId(null)}
        onRename={async title => {
          if (!selectedArtifact) return
          try {
            await rename(selectedArtifact.artifact_id, title)
          } catch (nextError) {
            showError(nextError)
            throw nextError
          }
        }}
        onRetry={async () => {
          if (!selectedArtifact) return
          try {
            await retry(selectedArtifact.artifact_id)
          } catch (nextError) {
            showError(nextError)
          }
        }}
        onDelete={async () => {
          if (selectedArtifact) {
            setPendingDeleteArtifactId(selectedArtifact.artifact_id)
          }
        }}
        onAskNode={request => {
          setSelectedArtifactId(null)
          onAskNode?.(request)
        }}
      />
    </div>
  )
}
