// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useRef } from 'react'
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
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { modelApis, UnifiedModel } from '@/apis/models'
import { correctionApis, CorrectionModeState } from '@/apis/correction'

interface CorrectionModeToggleProps {
  enabled: boolean
  onToggle: (enabled: boolean, modelId?: string, modelName?: string) => void
  disabled?: boolean
  correctionModelName?: string | null
  taskId: number | null
}

export default function CorrectionModeToggle({
  enabled,
  onToggle,
  disabled = false,
  correctionModelName,
  taskId,
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

  // Filter models by search query
  const filteredModels = models.filter(model => {
    const searchLower = searchQuery.toLowerCase()
    const nameMatch = model.name.toLowerCase().includes(searchLower)
    const displayNameMatch = model.displayName?.toLowerCase().includes(searchLower)
    return nameMatch || displayNameMatch
  })

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <ActionButton
                variant="outline"
                onClick={handleToggle}
                disabled={disabled}
                icon={<CheckCircle className="h-4 w-4" />}
                className={cn(
                  'transition-colors',
                  enabled
                    ? 'border-primary bg-primary/10 text-primary hover:bg-primary/20'
                    : 'border-border bg-base text-text-primary hover:bg-hover'
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

      {/* Model Selection Dialog */}
      <Dialog open={showModelSelector} onOpenChange={handleDialogClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('chat:correction.select_model')}</DialogTitle>
            <DialogDescription>{t('chat:correction.select_model_desc')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Search Input */}
            <Input
              placeholder={t('chat:correction.search_model')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full"
            />

            {/* Model List */}
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
