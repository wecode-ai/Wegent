// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useRef } from 'react'
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
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
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

  const filteredModels = models.filter(model => {
    const searchLower = searchQuery.toLowerCase()
    const nameMatch = model.name.toLowerCase().includes(searchLower)
    const displayNameMatch = model.displayName?.toLowerCase().includes(searchLower)
    return nameMatch || displayNameMatch
  })

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className={cn(
          'w-full flex items-center justify-between px-3 py-2.5',
          'text-left transition-colors',
          'hover:bg-hover active:bg-hover',
          'disabled:opacity-50 disabled:cursor-not-allowed'
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
      </button>

      {/* Model Selection Dialog */}
      <Dialog open={showModelSelector} onOpenChange={handleDialogClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('chat:correction.select_model')}</DialogTitle>
            <DialogDescription>{t('chat:correction.select_model_desc')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Input
              placeholder={t('chat:correction.search_model')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full"
            />

            <ScrollArea className="h-[300px] pr-4">
              {isLoading ? (
                <div className="flex items-center justify-center h-full">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
                </div>
              ) : filteredModels.length === 0 ? (
                <div className="flex items-center justify-center h-full text-text-muted">
                  {t('chat:correction.no_models')}
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredModels.map(model => (
                    <Button
                      key={`${model.type}-${model.name}`}
                      variant="ghost"
                      className="w-full justify-start text-left h-auto py-3 px-4 hover:bg-hover"
                      onClick={() => handleModelSelect(model)}
                    >
                      <div className="flex flex-col items-start gap-1">
                        <span className="font-medium">{model.displayName || model.name}</span>
                        {model.displayName && model.displayName !== model.name && (
                          <span className="text-xs text-text-muted">{model.name}</span>
                        )}
                        <span className="text-xs text-text-muted capitalize">
                          {model.type === 'public'
                            ? t('chat:correction.public_model')
                            : t('chat:correction.user_model')}
                        </span>
                      </div>
                    </Button>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
