// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import ModelSelector from '../selector/ModelSelector'
import { ResolutionSelector, RatioSelector } from '../selector'
import SendButton from './SendButton'
import type { Model } from '../../hooks/useModelSelection'

export interface VideoInputControlsProps {
  // Video model - videoModels is kept for backward compatibility but not used
  // ModelSelector fetches models internally via useModelSelection hook
  videoModels?: Model[]
  selectedModel: Model | null
  onModelChange: (model: Model) => void
  isModelsLoading?: boolean

  // Resolution
  selectedResolution: string
  onResolutionChange: (resolution: string) => void
  availableResolutions?: string[]

  // Aspect ratio
  selectedRatio: string
  onRatioChange: (ratio: string) => void
  availableRatios?: string[]

  // State
  isLoading: boolean
  isStreaming: boolean
  disabled?: boolean
  canSubmit?: boolean

  // Actions
  onSend: () => void
  onStop?: () => void
}

/**
 * VideoInputControls Component
 *
 * Renders the bottom control bar for video generation mode, including:
 * - Video model selector (using unified ModelSelector with modelCategoryType="video")
 * - Resolution selector
 * - Aspect ratio selector
 * - Send/Stop button
 *
 * This component is designed for video generation tasks and provides
 * a streamlined interface for configuring video generation parameters.
 */
export function VideoInputControls({
  videoModels: _videoModels,
  selectedModel,
  onModelChange,
  isModelsLoading = false,
  selectedResolution,
  onResolutionChange,
  availableResolutions,
  selectedRatio,
  onRatioChange,
  availableRatios,
  isLoading,
  isStreaming,
  disabled = false,
  canSubmit = true,
  onSend,
  onStop,
}: VideoInputControlsProps) {
  const { t } = useTranslation('common')
  const isDisabled = disabled || isLoading || isStreaming

  return (
    <div className="flex items-center justify-between px-3 pb-2 pt-1 gap-2">
      <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
        {/* Video Model Selector - using unified ModelSelector with video category */}
        <ModelSelector
          selectedModel={selectedModel}
          setSelectedModel={model => model && onModelChange(model)}
          forceOverride={false}
          setForceOverride={() => {}}
          selectedTeam={null}
          disabled={isDisabled}
          isLoading={isModelsLoading}
          modelCategoryType="video"
        />

        {/* Resolution Selector */}
        <ResolutionSelector
          selectedResolution={selectedResolution}
          onResolutionChange={onResolutionChange}
          availableResolutions={availableResolutions}
          disabled={isDisabled}
        />

        {/* Aspect Ratio Selector */}
        <RatioSelector
          selectedRatio={selectedRatio}
          onRatioChange={onRatioChange}
          availableRatios={availableRatios}
          disabled={isDisabled}
        />
      </div>

      <div className="ml-auto flex items-center gap-2 flex-shrink-0">
        {/* Send/Stop Button */}
        {isStreaming && onStop ? (
          <button
            onClick={onStop}
            className={cn(
              'h-11 min-w-[44px] px-4 rounded-full',
              'bg-orange-100 hover:bg-orange-200 dark:bg-orange-900/30 dark:hover:bg-orange-900/50',
              'transition-colors flex items-center justify-center gap-2'
            )}
            title={t('actions.stop')}
          >
            <Square className="h-4 w-4 text-orange-600 dark:text-orange-400" />
            <span className="text-sm text-orange-600 dark:text-orange-400 hidden sm:inline">
              {t('actions.stop')}
            </span>
          </button>
        ) : (
          <SendButton
            onClick={onSend}
            disabled={!canSubmit || isDisabled || !selectedModel}
            isLoading={isLoading}
          />
        )}
      </div>
    </div>
  )
}

export default VideoInputControls
