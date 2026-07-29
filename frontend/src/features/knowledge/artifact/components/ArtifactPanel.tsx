// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ChevronRight,
  FileText,
  Network,
  Plus,
  Presentation,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
import type {
  ArtifactPromptRequest,
  KnowledgeArtifact,
  KnowledgeArtifactType,
} from '@/types/knowledge-artifact'

interface ArtifactPanelProps {
  knowledgeBaseId: number
  selectedDocumentIds: number[]
  onAdjustSources: (onApplied?: () => void) => void
  onAvailableDocumentCountChange?: (count: number | null) => void
  onAskNode?: (request: ArtifactPromptRequest) => void
  onCreatePptDraft: () => void
  refreshToken?: number
  layout?: 'full' | 'rail'
}

interface CapabilityCardProps {
  icon: LucideIcon
  label: string
  description: string
  disabled: boolean
  onClick: () => void
  testId: string
  tone: string
}

function CapabilityCard({
  icon: Icon,
  label,
  description,
  disabled,
  onClick,
  testId,
  tone,
}: CapabilityCardProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="group flex h-16 w-full flex-col gap-0.5 rounded-xl border border-border bg-surface px-3 py-2 text-left transition-colors hover:border-primary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onClick}
          disabled={disabled}
          data-testid={testId}
        >
          <div className="flex w-full items-center justify-between">
            <div className={`flex h-6 w-6 items-center justify-center rounded-md ${tone}`}>
              <Icon className="h-4 w-4" />
            </div>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
          </div>
          <div className="w-full truncate text-sm font-medium leading-5">{label}</div>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        sideOffset={6}
        className="max-w-64 py-2 leading-5"
      >
        {description}
      </TooltipContent>
    </Tooltip>
  )
}

type CapabilityRailButtonProps = CapabilityCardProps

function CapabilityRailButton({
  icon: Icon,
  label,
  description,
  disabled,
  onClick,
  testId,
  tone,
}: CapabilityRailButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={`relative flex h-11 w-11 items-center justify-center rounded-xl transition-colors hover:ring-1 hover:ring-primary disabled:cursor-not-allowed disabled:opacity-50 ${tone}`}
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          data-testid={`artifact-rail-${testId}`}
        >
          <Icon className="h-5 w-5" />
          <Plus className="absolute bottom-1 right-1 h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={8} className="max-w-64">
        <p className="font-medium">{label}</p>
        <p className="mt-0.5 text-xs opacity-80">{description}</p>
      </TooltipContent>
    </Tooltip>
  )
}

function ArtifactRailButton({
  artifact,
  onOpen,
}: {
  artifact: KnowledgeArtifact
  onOpen: () => void
}) {
  const { t } = useTranslation('knowledge')
  const isMindMap = artifact.artifact_type === 'mind_map'
  const label = artifact.title || t(`artifact.type.${isMindMap ? 'mindMap' : 'briefing'}`)
  const status = t(
    artifact.execution_health === 'stalled'
      ? 'artifact.status.stalled'
      : `artifact.status.${artifact.status}`
  )
  const Icon = isMindMap ? Network : FileText

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex h-11 w-11 items-center justify-center rounded-xl text-primary transition-colors hover:bg-primary/10"
          onClick={onOpen}
          aria-label={label}
          data-testid={`artifact-rail-item-${artifact.artifact_id}`}
        >
          <Icon className="h-5 w-5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={8} className="max-w-64">
        <p className="truncate font-medium">{label}</p>
        <p className="mt-0.5 text-xs opacity-80">{status}</p>
      </TooltipContent>
    </Tooltip>
  )
}

export function ArtifactPanel({
  knowledgeBaseId,
  selectedDocumentIds,
  onAdjustSources,
  onAvailableDocumentCountChange,
  onAskNode,
  onCreatePptDraft,
  refreshToken = 0,
  layout = 'full',
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
  const previousRefreshTokenRef = useRef(refreshToken)
  const [createOpen, setCreateOpen] = useState(false)
  const [createType, setCreateType] = useState<KnowledgeArtifactType>('briefing')
  const [createSessionKey, setCreateSessionKey] = useState(0)
  const [pptDraftDialogOpen, setPptDraftDialogOpen] = useState(false)
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
    if (previousRefreshTokenRef.current === refreshToken) return
    previousRefreshTokenRef.current = refreshToken
    void refresh()
  }, [refresh, refreshToken])

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

  const capabilities: CapabilityCardProps[] = [
    ...(canManage
      ? [
          {
            icon: Network,
            label: t('artifact.action.mind_map'),
            description: t('artifact.type.mindMapHint'),
            disabled: effectiveAvailableDocumentCount === 0,
            onClick: () => openCreate('mind_map'),
            testId: 'artifact-type-mind-map',
            tone: 'bg-purple-500/10 text-purple-600 dark:bg-purple-500/20 dark:text-purple-300',
          },
        ]
      : []),
    {
      icon: Presentation,
      label: t('artifact.action.presentation'),
      description: t('artifact.type.presentationHint'),
      disabled: availableDocumentCount === 0,
      onClick: () => setPptDraftDialogOpen(true),
      testId: 'artifact-type-presentation',
      tone: 'bg-amber-500/10 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
    },
    ...(canManage
      ? [
          {
            icon: FileText,
            label: t('artifact.action.briefing'),
            description: t('artifact.type.briefingHint'),
            disabled: effectiveAvailableDocumentCount === 0,
            onClick: () => openCreate('briefing'),
            testId: 'artifact-type-briefing',
            tone: 'bg-blue-500/10 text-blue-600 dark:bg-blue-500/20 dark:text-blue-300',
          },
        ]
      : []),
  ]

  return (
    <div className="flex h-full flex-col" data-testid="artifact-panel">
      {layout === 'rail' ? (
        <TooltipProvider delayDuration={300}>
          <div className="flex min-h-0 flex-1 flex-col items-center" data-testid="artifact-rail">
            <div className="flex w-full shrink-0 flex-col items-center gap-3 border-b border-border pb-4">
              {capabilities.map(capability => (
                <CapabilityRailButton key={capability.testId} {...capability} />
              ))}
            </div>
            <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
              {items.slice(0, 5).map(artifact => (
                <ArtifactRailButton
                  key={artifact.artifact_id}
                  artifact={artifact}
                  onOpen={() => setSelectedArtifactId(artifact.artifact_id)}
                />
              ))}
              {error && items.length === 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="flex h-11 w-11 items-center justify-center rounded-xl text-error hover:bg-error/10"
                      onClick={() => void refresh(true)}
                      aria-label={t('artifact.retry')}
                      data-testid="artifact-rail-refresh-button"
                    >
                      <AlertCircle className="h-5 w-5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left">{t('artifact.loadFailed')}</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </TooltipProvider>
      ) : (
        <>
          <div className="mb-4">
            <TooltipProvider delayDuration={300}>
              <div className="grid grid-cols-2 gap-2">
                {capabilities.map(capability => (
                  <CapabilityCard key={capability.testId} {...capability} />
                ))}
              </div>
            </TooltipProvider>
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
        </>
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
              variant="primary"
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
      <AlertDialog open={pptDraftDialogOpen} onOpenChange={setPptDraftDialogOpen}>
        <AlertDialogContent className="sm:max-w-xl" data-testid="ppt-draft-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('artifact.action.presentation')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('artifact.presentationDialog.description')}
              <span className="mt-2 block">{t('artifact.presentationDialog.notice')}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="ppt-draft-cancel">
              {t('artifact.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="primary"
              data-testid="ppt-draft-continue"
              onClick={() => {
                setPptDraftDialogOpen(false)
                onCreatePptDraft()
              }}
            >
              {t('artifact.presentationDialog.continue')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
