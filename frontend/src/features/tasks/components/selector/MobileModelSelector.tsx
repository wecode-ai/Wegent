// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect } from 'react'
import { Check, Search, Settings } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { paths } from '@/config/paths'
import { Switch } from '@/components/ui/switch'
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer'
import { useModelSelection } from '@/features/tasks/hooks/useModelSelection'
import type { Team } from '@/types/api'
import type { Model } from '@/features/tasks/hooks/useModelSelection'
import { DEFAULT_MODEL_NAME } from '@/features/tasks/hooks/useModelSelection'

/** Get display text for a model */
function getModelDisplayText(model: Model): string {
  return model.displayName || model.name
}

/** Get unique key for model */
function getModelKey(model: Model): string {
  return `${model.name}:${model.type || ''}`
}

interface MobileModelSelectorProps {
  selectedModel: Model | null
  setSelectedModel: (model: Model | null) => void
  forceOverride: boolean
  setForceOverride: (force: boolean) => void
  selectedTeam: Team | null
  disabled: boolean
  isLoading?: boolean
  teamId?: number | null
  taskId?: number | null
  taskModelId?: string | null
}

/**
 * Mobile Model Selector - iOS Style
 * Bottom sheet with native iOS design patterns
 */
export default function MobileModelSelector({
  selectedModel: externalSelectedModel,
  setSelectedModel: externalSetSelectedModel,
  forceOverride: externalForceOverride,
  setForceOverride: externalSetForceOverride,
  selectedTeam,
  disabled,
  isLoading: externalLoading,
  teamId,
  taskId,
  taskModelId,
}: MobileModelSelectorProps) {
  const { t } = useTranslation()
  const router = useRouter()

  const modelSelection = useModelSelection({
    teamId: teamId ?? null,
    taskId: taskId ?? null,
    taskModelId,
    selectedTeam,
    disabled,
  })

  // Sync external state with hook state
  useEffect(() => {
    if (modelSelection.selectedModel !== externalSelectedModel) {
      if (modelSelection.selectedModel) {
        externalSetSelectedModel(modelSelection.selectedModel)
      }
    }
  }, [modelSelection.selectedModel, externalSelectedModel, externalSetSelectedModel])

  useEffect(() => {
    if (modelSelection.forceOverride !== externalForceOverride) {
      externalSetForceOverride(modelSelection.forceOverride)
    }
  }, [modelSelection.forceOverride, externalForceOverride, externalSetForceOverride])

  const [isOpen, setIsOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const [isSearchFocused, setIsSearchFocused] = useState(false)

  useEffect(() => {
    if (!isOpen) {
      setSearchValue('')
      setIsSearchFocused(false)
    }
  }, [isOpen])

  const isDisabled =
    disabled || externalLoading || modelSelection.isLoading || modelSelection.isMixedTeam

  const handleModelSelect = (value: string) => {
    modelSelection.selectModelByKey(value)
    setIsOpen(false)
  }

  // Filter models based on search
  const filteredModels = modelSelection.filteredModels.filter(model => {
    if (!searchValue.trim()) return true
    const search = searchValue.toLowerCase()
    return (
      model.name.toLowerCase().includes(search) ||
      model.displayName?.toLowerCase().includes(search) ||
      model.modelId?.toLowerCase().includes(search)
    )
  })

  const showDefaultInSearch =
    modelSelection.showDefaultOption &&
    (!searchValue.trim() ||
      t('common:task_submit.default_model', '默认')
        .toLowerCase()
        .includes(searchValue.toLowerCase()))

  return (
    <Drawer open={isOpen} onOpenChange={setIsOpen}>
      <DrawerTrigger asChild>
        <button
          type="button"
          disabled={isDisabled}
          className={cn(
            'flex items-center min-w-0 max-w-full rounded-full px-3 py-2 h-9',
            'border transition-colors overflow-hidden',
            modelSelection.isModelRequired
              ? 'border-error text-error bg-error/5'
              : 'border-border bg-base text-text-primary',
            modelSelection.isLoading || externalLoading ? 'animate-pulse' : '',
            'focus:outline-none focus:ring-0',
            'active:opacity-70',
            'disabled:cursor-not-allowed disabled:opacity-50'
          )}
        >
          <span className="truncate text-xs min-w-0">{modelSelection.getDisplayText()}</span>
        </button>
      </DrawerTrigger>

      <DrawerContent className="max-h-[85vh] bg-[#f2f2f7] dark:bg-[#1c1c1e]" showHandle={false}>
        {/* iOS-style drag handle */}
        <div className="flex justify-center pt-2 pb-3">
          <div className="w-9 h-1 rounded-full bg-[#3c3c43]/30 dark:bg-[#5c5c5e]" />
        </div>

        {/* Search bar - iOS style */}
        <div className="px-4 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#8e8e93]" />
            <input
              type="text"
              placeholder={t('common:task_submit.search_model', '搜索')}
              value={searchValue}
              onChange={e => setSearchValue(e.target.value)}
              onFocus={() => setIsSearchFocused(true)}
              onBlur={() => setIsSearchFocused(false)}
              className={cn(
                'w-full h-9 pl-9 pr-3 rounded-lg',
                'bg-[#e5e5ea] dark:bg-[#2c2c2e]',
                'text-sm text-text-primary placeholder:text-[#8e8e93]',
                'border-0 outline-none focus:ring-0'
              )}
            />
          </div>
        </div>

        {/* Model list - iOS grouped style */}
        <div
          className={cn(
            'flex-1 overflow-y-auto px-4 pb-4',
            isSearchFocused ? 'max-h-[70vh]' : 'max-h-[50vh]'
          )}
        >
          {modelSelection.error ? (
            <div className="rounded-xl bg-white dark:bg-[#2c2c2e] p-4 text-center text-sm text-error">
              {modelSelection.error}
            </div>
          ) : filteredModels.length === 0 && !showDefaultInSearch ? (
            <div className="rounded-xl bg-white dark:bg-[#2c2c2e] p-4 text-center text-sm text-[#8e8e93]">
              {modelSelection.isLoading
                ? t('common:loading', '加载中...')
                : t('common:models.no_models', '暂无模型')}
            </div>
          ) : (
            <div className="rounded-xl bg-white dark:bg-[#2c2c2e] overflow-hidden">
              {/* Default option */}
              {showDefaultInSearch && (
                <button
                  type="button"
                  onClick={() => handleModelSelect(DEFAULT_MODEL_NAME)}
                  className={cn(
                    'w-full flex items-center justify-between px-4 py-3',
                    'text-left active:bg-[#d1d1d6] dark:active:bg-[#3a3a3c]',
                    'border-b border-[#c6c6c8] dark:border-[#38383a] last:border-b-0'
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[15px] text-text-primary">
                      {t('common:task_submit.default_model', '默认')}
                    </div>
                    <div className="text-[13px] text-[#8e8e93] mt-0.5">
                      {t('common:task_submit.use_bot_model', '使用 Bot 预设模型')}
                    </div>
                  </div>
                  {modelSelection.selectedModel?.name === DEFAULT_MODEL_NAME && (
                    <Check className="h-5 w-5 text-[#007aff] flex-shrink-0 ml-3" />
                  )}
                </button>
              )}

              {/* Model items */}
              {filteredModels.map((model, index) => {
                const isSelected =
                  modelSelection.selectedModel?.name === model.name &&
                  modelSelection.selectedModel?.type === model.type
                const isLast = index === filteredModels.length - 1 && !showDefaultInSearch

                return (
                  <button
                    key={getModelKey(model)}
                    type="button"
                    onClick={() => handleModelSelect(getModelKey(model))}
                    className={cn(
                      'w-full flex items-center justify-between px-4 py-3',
                      'text-left active:bg-[#d1d1d6] dark:active:bg-[#3a3a3c]',
                      !isLast && 'border-b border-[#c6c6c8] dark:border-[#38383a]'
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] text-text-primary truncate">
                        {getModelDisplayText(model)}
                      </div>
                      {model.modelId && (
                        <div className="text-[13px] text-[#8e8e93] mt-0.5 truncate">
                          {model.modelId}
                        </div>
                      )}
                    </div>
                    {isSelected && <Check className="h-5 w-5 text-[#007aff] flex-shrink-0 ml-3" />}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer - compact single row */}
        {!isSearchFocused && (
          <div className="px-4 pb-4 pt-2">
            <div className="flex items-center justify-between">
              {/* Override toggle - left */}
              {modelSelection.selectedModel && !modelSelection.isMixedTeam ? (
                <button
                  type="button"
                  onClick={() => modelSelection.setForceOverride(!modelSelection.forceOverride)}
                  className="flex items-center gap-2 active:opacity-70"
                >
                  <Switch
                    checked={modelSelection.forceOverride}
                    onCheckedChange={modelSelection.setForceOverride}
                    disabled={disabled || externalLoading}
                    onClick={e => e.stopPropagation()}
                    className="scale-90"
                  />
                  <span className="text-[13px] text-[#8e8e93]">
                    {t('common:task_submit.override_default_model', '覆盖默认')}
                  </span>
                </button>
              ) : (
                <div />
              )}

              {/* Settings link - right */}
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false)
                  router.push(paths.settings.models.getHref())
                }}
                className="flex items-center gap-1.5 text-[#007aff] active:opacity-70"
              >
                <Settings className="h-4 w-4" />
                <span className="text-[13px]">{t('common:models.manage', '设置')}</span>
              </button>
            </div>
          </div>
        )}
      </DrawerContent>
    </Drawer>
  )
}
