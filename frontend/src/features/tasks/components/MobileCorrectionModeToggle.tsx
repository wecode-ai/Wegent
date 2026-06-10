// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useMemo, useRef } from 'react'
import { Sparkles } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
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

interface MobileCorrectionModeToggleProps {
  enabled: boolean
  onToggle: (enabled: boolean, modelId?: string, modelName?: string) => void
  disabled?: boolean
  correctionModelName?: string | null
  taskId: number | null
}

/**
 * Mobile-specific Correction Mode Toggle
 * Renders as a full-width clickable row with a switch
 */
export default function MobileCorrectionModeToggle({
  enabled,
  onToggle,
  disabled = false,
  correctionModelName,
  taskId,
}: MobileCorrectionModeToggleProps) {
  const { t } = useTranslation()
  const [showModelSelector, setShowModelSelector] = useState(false)
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const prevTaskIdRef = useRef<number | null | undefined>(undefined)

  useEffect(() => {
    if (showModelSelector) {
      loadModels()
    }
  }, [showModelSelector])

  useEffect(() => {
    const prevTaskId = prevTaskIdRef.current

    if (prevTaskId === null && taskId !== null && taskId > 0) {
      const migratedState = correctionApis.migrateCorrectionModeState(null, taskId)
      if (migratedState && migratedState.enabled && migratedState.correctionModelId) {
        onToggle(
          true,
          migratedState.correctionModelId,
          migratedState.correctionModelName || undefined
        )
        prevTaskIdRef.current = taskId
        return
      }
    }

    const savedState = correctionApis.getCorrectionModeState(taskId)
    if (savedState.enabled && savedState.correctionModelId) {
      onToggle(true, savedState.correctionModelId, savedState.correctionModelName || undefined)
    } else {
      onToggle(false)
    }

    prevTaskIdRef.current = taskId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  const loadModels = async () => {
    setIsLoading(true)
    try {
      const response = await modelApis.getUnifiedModels(undefined, false, 'all', undefined, 'llm')
      setModels(response.data || [])
    } catch (error) {
      console.error('Failed to load models:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleClick = () => {
    if (disabled) return

    if (!enabled) {
      setShowModelSelector(true)
    } else {
      onToggle(false)
      correctionApis.clearCorrectionModeState(taskId)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return

    event.preventDefault()
    handleClick()
  }

  const handleModelSelect = (model: UnifiedModel) => {
    const displayName = model.displayName || model.name
    onToggle(true, model.name, displayName)

    const state: CorrectionModeState = {
      enabled: true,
      correctionModelId: model.name,
      correctionModelName: displayName,
      enableWebSearch: true,
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

  return (
    <>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={cn(
          'w-full flex items-center justify-between px-3 py-2.5',
          'text-left transition-colors',
          'hover:bg-hover active:bg-hover',
          disabled && 'cursor-not-allowed opacity-50'
        )}
      >
        <div className="flex items-center gap-3">
          <Sparkles className="h-4 w-4 text-text-muted" />
          <div className="flex flex-col">
            <span className="text-sm">纠错模式</span>
            {enabled && correctionModelName && (
              <span className="text-xs text-text-muted truncate max-w-[120px]">
                {correctionModelName}
              </span>
            )}
          </div>
        </div>
        <Switch
          checked={enabled}
          disabled={disabled}
          onClick={e => e.stopPropagation()}
          onCheckedChange={checked => {
            if (!checked) {
              onToggle(false)
              correctionApis.clearCorrectionModeState(taskId)
            } else {
              setShowModelSelector(true)
            }
          }}
        />
      </div>

      {/* Model Selection Dialog */}
      <Dialog open={showModelSelector} onOpenChange={handleDialogClose}>
        <DialogContent className="max-w-[calc(100vw-16px)] overflow-x-auto sm:max-w-3xl">
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
              className="w-[min(720px,calc(100vw-48px))]"
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
    </>
  )
}
