// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, FileText, Network } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { ArtifactCreateDialog } from './ArtifactCreateDialog'
import { ArtifactViewer } from './ArtifactViewer'
import { useKnowledgeArtifacts } from '../hooks/useKnowledgeArtifacts'
import type { KnowledgeArtifactType } from '@/types/knowledge-artifact'

interface ArtifactPanelProps {
  knowledgeBaseId: number
  selectedDocumentIds: number[]
  onAdjustSources: (onApplied?: () => void) => void
  onAvailableDocumentCountChange?: (count: number | null) => void
}

export function ArtifactPanel({
  knowledgeBaseId,
  selectedDocumentIds,
  onAdjustSources,
  onAvailableDocumentCountChange,
}: ArtifactPanelProps) {
  const { t, i18n } = useTranslation('knowledge')
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
  const selectedArtifact = useMemo(
    () => items.find(item => item.artifact_id === selectedArtifactId) ?? null,
    [items, selectedArtifactId]
  )
  const effectiveAvailableDocumentCount = availableDocumentCount ?? 0

  useEffect(() => {
    onAvailableDocumentCountChange?.(availableDocumentCount)
  }, [availableDocumentCount, onAvailableDocumentCountChange])

  const showError = (nextError: unknown) => {
    toast({
      description: nextError instanceof Error ? nextError.message : t('artifact.operationFailed'),
      variant: 'destructive',
    })
  }

  const handleDelete = async () => {
    if (!selectedArtifact) return
    try {
      await remove(selectedArtifact.artifact_id)
      setSelectedArtifactId(null)
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
      <div className="mb-5">
        <h3 className="mb-3 text-sm font-semibold">{t('artifact.commonCapabilities')}</h3>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            className="group rounded-xl border border-border bg-surface p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
            onClick={() => openCreate('briefing')}
            disabled={effectiveAvailableDocumentCount === 0}
            data-testid="artifact-type-briefing"
          >
            <div className="mb-3 inline-flex rounded-xl bg-primary/10 p-3 text-primary transition-colors group-hover:bg-primary group-hover:text-white">
              <FileText className="h-6 w-6" />
            </div>
            <div className="font-medium">{t('artifact.action.briefing')}</div>
            <div className="mt-1 text-xs leading-5 text-text-secondary">
              {t('artifact.type.briefingHint')}
            </div>
          </button>
          <button
            type="button"
            className="group rounded-xl border border-border bg-surface p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
            onClick={() => openCreate('mind_map')}
            disabled={effectiveAvailableDocumentCount === 0}
            data-testid="artifact-type-mind-map"
          >
            <div className="mb-3 inline-flex rounded-xl bg-primary/10 p-3 text-primary transition-colors group-hover:bg-primary group-hover:text-white">
              <Network className="h-6 w-6" />
            </div>
            <div className="font-medium">{t('artifact.action.mind_map')}</div>
            <div className="mt-1 text-xs leading-5 text-text-secondary">
              {t('artifact.type.mindMapHint')}
            </div>
          </button>
        </div>
        {!isLoading && effectiveAvailableDocumentCount === 0 && (
          <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-text-secondary">
            {t(
              processingDocumentCount > 0
                ? 'artifact.documentsProcessingHint'
                : 'artifact.noDocumentsHint'
            )}
          </p>
        )}
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('artifact.recentTasks')}</h3>
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
          <p className="mt-1 text-xs text-text-secondary">{t('artifact.emptyHint')}</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-auto pb-4">
          {items.map(artifact => (
            <button
              key={artifact.artifact_id}
              type="button"
              className="w-full rounded-lg border border-border p-3 text-left transition-colors hover:bg-hover"
              onClick={() => setSelectedArtifactId(artifact.artifact_id)}
              data-testid={`artifact-card-${artifact.artifact_id}`}
            >
              <div className="flex items-start gap-3">
                <div className="rounded-md bg-primary/10 p-2 text-primary">
                  {artifact.artifact_type === 'mind_map' ? (
                    <Network className="h-4 w-4" />
                  ) : (
                    <FileText className="h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{artifact.title}</div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-xs text-text-secondary">
                    <span>
                      {t(
                        artifact.execution_health === 'stalled'
                          ? 'artifact.status.stalled'
                          : `artifact.status.${artifact.status}`
                      )}
                    </span>
                    <span>
                      {new Intl.DateTimeFormat(i18n.language, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      }).format(new Date(artifact.created_at))}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-xs text-text-muted">
                    {t('artifact.sourceCount', {
                      count: artifact.source_document_ids.length,
                    })}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

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
        onDelete={handleDelete}
      />
    </div>
  )
}
