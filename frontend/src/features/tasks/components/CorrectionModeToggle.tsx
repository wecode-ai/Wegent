// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useMemo, useRef } from 'react'
import { CheckCircle } from 'lucide-react'
import { ActionButton } from '@/components/ui/action-button'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  ModelCascadeContent,
  type ModelCascadeLabels,
} from '@/components/model-select/ModelCascadeSelect'
import { modelApis, UnifiedModel } from '@/apis/models'
import { correctionApis, CorrectionModeState } from '@/apis/correction'

interface CorrectionModeToggleProps {
  enabled: boolean
  onToggle: (enabled: boolean, modelId?: string, modelName?: string) => void
  disabled?: boolean
  correctionModelName?: string | null
  taskId: number | null
  triggerVariant?: 'button' | 'menu-item'
}

export default function CorrectionModeToggle({
  enabled,
  onToggle,
  disabled = false,
  correctionModelName,
  taskId,
  triggerVariant = 'button',
}: CorrectionModeToggleProps) {
  const { t } = useTranslation()
  const [showModelSelector, setShowModelSelector] = useState(false)
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Track previous taskId to detect transitions from null to real taskId
  const prevTaskIdRef = useRef<number | null | undefined>(undefined)

  // Load models when dialog opens
  useEffect(() => {
    if (showModelSelector) {
      loadModels()
    }
  }, [showModelSelector])

  // Restore state from localStorage when taskId changes
  // Also handle migration from "new" task to real taskId
  useEffect(() => {
    const prevTaskId = prevTaskIdRef.current

    // Check if this is a transition from null (new task) to a real taskId
    // This happens when a new task is created after sending a message
    if (prevTaskId === null && taskId !== null && taskId > 0) {
      // Try to migrate state from "new" task to real taskId
      const migratedState = correctionApis.migrateCorrectionModeState(null, taskId)
      if (migratedState && migratedState.enabled && migratedState.correctionModelId) {
        // State was migrated, apply it
        onToggle(
          true,
          migratedState.correctionModelId,
          migratedState.correctionModelName || undefined
        )
        prevTaskIdRef.current = taskId
        return
      }
    }

    // Normal case: restore state from localStorage for the current taskId
    const savedState = correctionApis.getCorrectionModeState(taskId)
    if (savedState.enabled && savedState.correctionModelId) {
      onToggle(true, savedState.correctionModelId, savedState.correctionModelName || undefined)
    } else {
      // Reset correction mode when switching to a task without saved state
      onToggle(false)
    }

    // Update previous taskId ref
    prevTaskIdRef.current = taskId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  const loadModels = async () => {
    setIsLoading(true)
    try {
      // Get all unified models (both public and user-defined) for LLM type
      const response = await modelApis.getUnifiedModels(undefined, false, 'all', undefined, 'llm')
      setModels(response.data || [])
    } catch (error) {
      console.error('Failed to load models:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleToggle = () => {
    if (!enabled) {
      // Opening: show model selector
      setShowModelSelector(true)
    } else {
      // Closing: disable correction mode
      onToggle(false)
      correctionApis.clearCorrectionModeState(taskId)
    }
  }

  const handleModelSelect = (model: UnifiedModel) => {
    const displayName = model.displayName || model.name
    onToggle(true, model.name, displayName)

    // Save to localStorage with web search enabled by default
    const state: CorrectionModeState = {
      enabled: true,
      correctionModelId: model.name,
      correctionModelName: displayName,
      enableWebSearch: true, // Enable web search by default for fact verification
    }
    correctionApis.saveCorrectionModeState(taskId, state)

    setShowModelSelector(false)
    setSearchQuery('')
  }

  const handleDialogClose = () => {
    setShowModelSelector(false)
    setSearchQuery('')
  }

  const cascadeLabels: ModelCascadeLabels = useMemo(
    () => ({
      ungrouped: t('common:models.ungrouped', 'Ungrouped'),
      uncategorized: t('common:models.uncategorized', 'Uncategorized'),
      searchPlaceholder: t('common:models.search_models', 'Search models or groups...'),
      searchResults: t('common:models.search_results', 'Search results'),
      noModels: t('chat:correction.no_models'),
      noMatch: t('common:models.no_match', 'No matching models'),
      primaryGroups: t('common:models.primary_groups', 'Primary groups'),
      secondaryGroups: t('common:models.secondary_groups', 'Secondary groups'),
    }),
    [t]
  )

  const modelSelectionDialog = (
    <Dialog open={showModelSelector} onOpenChange={handleDialogClose}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('chat:correction.select_model')}</DialogTitle>
          <DialogDescription>{t('chat:correction.select_model_desc')}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex h-[320px] items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary" />
          </div>
        ) : (
          <ModelCascadeContent
            models={models}
            labels={cascadeLabels}
            searchValue={searchQuery}
            onSearchValueChange={setSearchQuery}
            onSelectModel={handleModelSelect}
            getModelKey={model => `${model.type}-${model.name}`}
            className="w-full"
            renderModelBadges={model => (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-text-muted">
                {model.type === 'public'
                  ? t('chat:correction.public_model')
                  : t('chat:correction.user_model')}
              </span>
            )}
            renderModelMeta={model =>
              model.modelId ? (
                <span className="block truncate text-xs text-text-muted">{model.modelId}</span>
              ) : null
            }
          />
        )}
      </DialogContent>
    </Dialog>
  )

  if (triggerVariant === 'menu-item') {
    return (
      <>
        <button
          type="button"
          onClick={handleToggle}
          disabled={disabled}
          data-testid="correction-toggle"
          className={cn(
            'w-full flex items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-hover active:bg-hover disabled:opacity-50 disabled:cursor-not-allowed',
            enabled ? 'text-primary' : 'text-text-primary'
          )}
        >
          <span className="flex min-w-0 items-center gap-3">
            <CheckCircle className={cn('h-4 w-4', enabled ? 'text-primary' : 'text-text-muted')} />
            <span className="text-sm">{t('chat:correction.label')}</span>
          </span>
          {enabled && correctionModelName && (
            <span className="ml-3 max-w-24 truncate text-xs text-text-muted">
              {correctionModelName}
            </span>
          )}
        </button>

        {modelSelectionDialog}
      </>
    )
  }

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <ActionButton
                onClick={handleToggle}
                disabled={disabled}
                icon={<CheckCircle className="h-4 w-4" />}
                label={t('chat:correction.label')}
                className={cn(
                  'transition-colors',
                  enabled
                    ? 'bg-primary/10 text-primary hover:bg-primary/20'
                    : 'text-text-primary hover:bg-hover'
                )}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>
              {enabled
                ? `${t('chat:correction.disable')}${correctionModelName ? ` (${correctionModelName})` : ''}`
                : t('chat:correction.enable')}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {modelSelectionDialog}
    </>
  )
}
