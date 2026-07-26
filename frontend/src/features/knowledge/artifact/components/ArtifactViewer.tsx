// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, BookPlus, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import MermaidDiagram from '@/components/common/MermaidDiagram'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/hooks/useTranslation'
import { useTheme } from '@/features/theme/ThemeProvider'
import type { KnowledgeArtifact } from '@/types/knowledge-artifact'
import { useToast } from '@/hooks/use-toast'
import { ArtifactSaveDialog } from './ArtifactSaveDialog'

interface ArtifactViewerProps {
  artifact: KnowledgeArtifact | null
  canManage: boolean
  onClose: () => void
  onRename: (title: string) => Promise<void>
  onRetry: () => Promise<void>
  onDelete: () => Promise<void>
}

export function ArtifactViewer({
  artifact,
  canManage,
  onClose,
  onRename,
  onRetry,
  onDelete,
}: ArtifactViewerProps) {
  const { t } = useTranslation('knowledge')
  const { theme } = useTheme()
  const { toast } = useToast()
  const [isEditing, setIsEditing] = useState(false)
  const [isSaveOpen, setIsSaveOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setTitle(artifact?.title ?? '')
    setIsEditing(false)
  }, [artifact])

  if (!artifact) return null

  const handleRename = async () => {
    if (!title.trim()) return
    setIsSaving(true)
    try {
      await onRename(title.trim())
      setIsEditing(false)
    } catch {
      // The parent displays the API error. Keep edit mode open for retry.
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent
        className="flex h-[85vh] max-w-5xl flex-col"
        data-testid="artifact-viewer-dialog"
      >
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            {isEditing ? (
              <>
                <Input
                  value={title}
                  onChange={event => setTitle(event.target.value)}
                  maxLength={255}
                  data-testid="artifact-rename-input"
                />
                <Button
                  size="sm"
                  onClick={() => void handleRename()}
                  disabled={isSaving || !title.trim()}
                  data-testid="artifact-rename-save"
                >
                  {t('artifact.save')}
                </Button>
              </>
            ) : (
              <>
                <DialogTitle className="truncate">{artifact.title}</DialogTitle>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsEditing(true)}
                    data-testid="artifact-rename-button"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                )}
              </>
            )}
          </div>
          <DialogDescription>
            {t(`artifact.type.${artifact.artifact_type === 'mind_map' ? 'mindMap' : 'briefing'}`)}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border p-5">
          {artifact.status === 'succeeded' && artifact.content ? (
            artifact.artifact_type === 'mind_map' ? (
              <MermaidDiagram code={artifact.content} />
            ) : (
              <EnhancedMarkdown source={artifact.content} theme={theme} />
            )
          ) : artifact.status === 'failed' ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <p className="font-medium text-error">{t('artifact.failed')}</p>
              <p className="mt-2 max-w-lg text-sm text-text-secondary">
                {artifact.error_message || t('artifact.failedHint')}
              </p>
            </div>
          ) : artifact.execution_health === 'stalled' ? (
            <div
              className="flex h-full flex-col items-center justify-center text-center"
              data-testid="artifact-stalled-state"
            >
              <AlertCircle className="mb-3 h-8 w-8 text-warning" />
              <p className="font-medium">{t('artifact.stalled')}</p>
              <p className="mt-2 max-w-lg text-sm text-text-secondary">
                {t('artifact.stalledHint')}
              </p>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-text-secondary">
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              {t('artifact.generating')}
            </div>
          )}
        </div>
        {(canManage || artifact.can_retry || artifact.can_delete) && (
          <DialogFooter className="justify-between sm:justify-between">
            <div className="flex items-center gap-2">
              {artifact.can_delete && (
                <Button
                  variant="ghost"
                  className="text-error"
                  onClick={() => {
                    if (window.confirm(t('artifact.deleteConfirm'))) void onDelete()
                  }}
                  data-testid="artifact-delete-button"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('artifact.delete')}
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {canManage &&
                artifact.status === 'succeeded' &&
                artifact.artifact_type === 'briefing' &&
                artifact.content && (
                  <Button
                    variant="outline"
                    onClick={() => setIsSaveOpen(true)}
                    data-testid="artifact-save-to-knowledge-button"
                  >
                    <BookPlus className="mr-2 h-4 w-4" />
                    {t('artifact.saveToKnowledge')}
                  </Button>
                )}
              {artifact.can_retry && (
                <Button onClick={() => void onRetry()} data-testid="artifact-retry-button">
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t('artifact.retry')}
                </Button>
              )}
            </div>
          </DialogFooter>
        )}
      </DialogContent>
      {artifact.content && (
        <ArtifactSaveDialog
          open={isSaveOpen}
          onOpenChange={setIsSaveOpen}
          knowledgeBaseId={artifact.knowledge_base_id}
          initialTitle={artifact.title}
          initialContent={artifact.content}
          onSaved={() =>
            toast({
              description: t('artifact.savedToKnowledge'),
            })
          }
        />
      )}
    </Dialog>
  )
}
