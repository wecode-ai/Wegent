// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useState } from 'react'
import { AlertCircle, FileText, Network, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { ArtifactCreateDialog } from './ArtifactCreateDialog'
import { ArtifactViewer } from './ArtifactViewer'
import { useKnowledgeArtifacts } from '../hooks/useKnowledgeArtifacts'

interface ArtifactPanelProps {
  knowledgeBaseId: number
  selectedDocumentIds: number[]
}

export function ArtifactPanel({ knowledgeBaseId, selectedDocumentIds }: ArtifactPanelProps) {
  const { t, i18n } = useTranslation('knowledge')
  const { toast } = useToast()
  const { items, canManage, isLoading, error, create, rename, retry, remove, refresh } =
    useKnowledgeArtifacts(knowledgeBaseId)
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const selectedArtifact = useMemo(
    () => items.find(item => item.artifact_id === selectedArtifactId) ?? null,
    [items, selectedArtifactId]
  )

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

  return (
    <div className="flex h-full flex-col" data-testid="artifact-panel">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">{t('artifact.title')}</h3>
          <p className="text-xs text-text-secondary">{t('artifact.subtitle')}</p>
        </div>
        {canManage && (
          <Button
            size="sm"
            onClick={() => setCreateOpen(true)}
            data-testid="artifact-create-button"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t('artifact.create')}
          </Button>
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
        <div className="flex flex-1 flex-col items-center justify-center px-5 text-center">
          <div className="mb-3 rounded-full bg-primary/10 p-3">
            <FileText className="h-7 w-7 text-primary" />
          </div>
          <p className="font-medium">{t('artifact.empty')}</p>
          <p className="mt-1 text-sm text-text-secondary">{t('artifact.emptyHint')}</p>
          {canManage && (
            <Button
              className="mt-4"
              onClick={() => setCreateOpen(true)}
              data-testid="artifact-empty-create-button"
            >
              {t('artifact.createFirst')}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2 overflow-auto pb-4">
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
                  {(artifact.status === 'queued' || artifact.status === 'running') &&
                    artifact.execution_health !== 'stalled' && (
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-border">
                        <div className="h-full w-2/3 animate-pulse rounded-full bg-primary" />
                      </div>
                    )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      <ArtifactCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        selectedDocumentIds={selectedDocumentIds}
        onCreate={async request => {
          try {
            const artifact = await create(request)
            setSelectedArtifactId(artifact.artifact_id)
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
