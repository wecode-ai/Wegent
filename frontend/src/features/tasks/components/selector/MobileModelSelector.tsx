// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { Check, ChevronLeft, ChevronRight, Search, Settings } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { paths } from '@/config/paths'
import { Tag } from '@/components/ui/tag'
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer'
import {
  buildModelCascadeGroups,
  getModelDisplayName,
  matchesModelSearch,
} from '@/components/model-select/model-grouping'
import { useModelSelection } from '@/features/tasks/hooks/useModelSelection'
import type { Team } from '@/types/api'
import type { Model } from '@/features/tasks/hooks/useModelSelection'
import { DEFAULT_MODEL_NAME } from '@/features/tasks/hooks/useModelSelection'

/** Get display text for a model */
function getModelDisplayText(model: Model): string {
  return getModelDisplayName(model)
}

/** Get unique key for model */
function getModelKey(model: Model): string {
  return `${model.name}:${model.type || ''}`
}

type MobileModelStep = 'primary' | 'secondary' | 'models'

function getGroupName(model: Model, fallback: string): string {
  return model.modelGroup?.trim() || fallback
}

function getSubGroupName(model: Model, fallback: string): string {
  return model.modelSubGroup?.trim() || fallback
}

interface MobileModelSelectorProps {
  selectedModel: Model | null
  setSelectedModel: (model: Model | null) => void
  forceOverride?: boolean
  setForceOverride?: (force: boolean) => void
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
  forceOverride: externalForceOverride = false,
  setForceOverride: externalSetForceOverride = () => {},
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
  const [step, setStep] = useState<MobileModelStep>('primary')
  const [activeGroupName, setActiveGroupName] = useState('')
  const [activeSubGroupName, setActiveSubGroupName] = useState('')

  useEffect(() => {
    if (!isOpen) {
      setSearchValue('')
      setIsSearchFocused(false)
      setStep('primary')
    }
  }, [isOpen])

  const isDisabled =
    disabled || externalLoading || modelSelection.isLoading || modelSelection.isMixedTeam

  const handleModelSelect = (model: Model) => {
    modelSelection.selectModel(model)
    setIsOpen(false)
  }

  const groupLabels = useMemo(
    () => ({
      ungrouped: t('common:models.ungrouped', 'Ungrouped'),
      uncategorized: t('common:models.uncategorized', 'Uncategorized'),
    }),
    [t]
  )

  const cascadeGroups = useMemo(
    () =>
      buildModelCascadeGroups(modelSelection.filteredModels, {
        ungroupedLabel: groupLabels.ungrouped,
        uncategorizedLabel: groupLabels.uncategorized,
      }),
    [groupLabels.uncategorized, groupLabels.ungrouped, modelSelection.filteredModels]
  )

  useEffect(() => {
    if (!isOpen || cascadeGroups.length === 0) return

    const selectedGroupName =
      modelSelection.selectedModel && modelSelection.selectedModel.name !== DEFAULT_MODEL_NAME
        ? getGroupName(modelSelection.selectedModel, groupLabels.ungrouped)
        : ''
    const nextGroup =
      cascadeGroups.find(group => group.name === activeGroupName) ??
      cascadeGroups.find(group => group.name === selectedGroupName) ??
      cascadeGroups[0]
    const selectedSubGroupName =
      modelSelection.selectedModel && modelSelection.selectedModel.name !== DEFAULT_MODEL_NAME
        ? getSubGroupName(modelSelection.selectedModel, groupLabels.uncategorized)
        : ''
    const nextSubGroup =
      nextGroup.subGroups.find(subGroup => subGroup.name === activeSubGroupName) ??
      nextGroup.subGroups.find(subGroup => subGroup.name === selectedSubGroupName) ??
      nextGroup.subGroups[0]

    setActiveGroupName(nextGroup.name)
    setActiveSubGroupName(nextSubGroup?.name ?? '')
  }, [
    activeGroupName,
    activeSubGroupName,
    cascadeGroups,
    groupLabels.uncategorized,
    groupLabels.ungrouped,
    isOpen,
    modelSelection.selectedModel,
  ])

  const activeGroup =
    cascadeGroups.find(group => group.name === activeGroupName) ?? cascadeGroups[0]
  const activeSubGroup =
    activeGroup?.subGroups.find(subGroup => subGroup.name === activeSubGroupName) ??
    activeGroup?.subGroups[0]
  const normalizedSearchValue = searchValue.trim()
  const isSearching = normalizedSearchValue.length > 0
  const searchResults = modelSelection.filteredModels.filter(model =>
    matchesModelSearch(model, normalizedSearchValue)
  )

  const showDefaultInSearch =
    modelSelection.showDefaultOption &&
    (!normalizedSearchValue ||
      t('common:task_submit.default_model', '默认')
        .toLowerCase()
        .includes(normalizedSearchValue.toLowerCase()) ||
      t('common:task_submit.use_bot_model', '使用 Bot 预设模型')
        .toLowerCase()
        .includes(normalizedSearchValue.toLowerCase()))

  const renderDefaultRow = (withBorder = true) => (
    <button
      type="button"
      data-testid="mobile-model-default-option"
      onClick={() => {
        modelSelection.selectDefaultModel()
        setIsOpen(false)
      }}
      className={cn(
        'flex min-h-[44px] w-full items-center justify-between px-4 py-3 text-left',
        'active:bg-[#d1d1d6] dark:active:bg-[#3a3a3c]',
        withBorder && 'border-b border-[#c6c6c8] dark:border-[#38383a]'
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] text-text-primary">
          {t('common:task_submit.default_model', '默认')}
        </div>
        <div className="mt-0.5 truncate text-[13px] text-[#8e8e93]">
          {t('common:task_submit.use_bot_model', '使用 Bot 预设模型')}
        </div>
      </div>
      {modelSelection.selectedModel?.name === DEFAULT_MODEL_NAME && (
        <Check className="ml-3 h-5 w-5 flex-shrink-0 text-[#007aff]" />
      )}
    </button>
  )

  const renderModelRow = (model: Model, showPath: boolean, withBorder = true) => {
    const isSelected =
      modelSelection.selectedModel?.name === model.name &&
      modelSelection.selectedModel?.type === model.type
    const path = `${getGroupName(model, groupLabels.ungrouped)} / ${getSubGroupName(
      model,
      groupLabels.uncategorized
    )}`

    return (
      <button
        key={getModelKey(model)}
        type="button"
        data-testid={`mobile-model-option-${model.name.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
        onClick={() => handleModelSelect(model)}
        className={cn(
          'flex min-h-[44px] w-full items-center justify-between px-4 py-3 text-left',
          'active:bg-[#d1d1d6] dark:active:bg-[#3a3a3c]',
          withBorder && 'border-b border-[#c6c6c8] dark:border-[#38383a]'
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[15px] text-text-primary">
              {getModelDisplayText(model)}
            </span>
            {model.type === 'user' && (
              <Tag variant="info" className="flex-shrink-0 whitespace-nowrap text-[10px]">
                {t('common:settings.personal', '个人')}
              </Tag>
            )}
          </div>
          {showPath ? (
            <div className="mt-0.5 truncate text-[13px] text-[#8e8e93]">{path}</div>
          ) : (
            model.modelId && (
              <div className="mt-0.5 truncate text-[13px] text-[#8e8e93]">{model.modelId}</div>
            )
          )}
        </div>
        {isSelected && <Check className="ml-3 h-5 w-5 flex-shrink-0 text-[#007aff]" />}
      </button>
    )
  }

  const renderPrimaryGroups = () => (
    <div className="overflow-hidden rounded-xl bg-white dark:bg-[#2c2c2e]">
      {modelSelection.showDefaultOption && renderDefaultRow(cascadeGroups.length > 0)}
      {cascadeGroups.map((group, index) => {
        const isLast = index === cascadeGroups.length - 1

        return (
          <button
            key={group.name}
            type="button"
            data-testid={`mobile-model-primary-group-${group.name.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
            onClick={() => {
              setActiveGroupName(group.name)
              setActiveSubGroupName(group.subGroups[0]?.name ?? '')
              setStep('secondary')
            }}
            className={cn(
              'flex min-h-[44px] w-full items-center justify-between px-4 py-3 text-left',
              'active:bg-[#d1d1d6] dark:active:bg-[#3a3a3c]',
              !isLast && 'border-b border-[#c6c6c8] dark:border-[#38383a]'
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] text-text-primary">{group.name}</div>
              <div className="mt-0.5 text-[13px] text-[#8e8e93]">{group.count}</div>
            </div>
            <ChevronRight className="ml-3 h-5 w-5 flex-shrink-0 text-[#8e8e93]" />
          </button>
        )
      })}
    </div>
  )

  const renderSecondaryGroups = () => (
    <div className="overflow-hidden rounded-xl bg-white dark:bg-[#2c2c2e]">
      {activeGroup?.subGroups.map((subGroup, index) => {
        const isLast = index === activeGroup.subGroups.length - 1

        return (
          <button
            key={subGroup.name}
            type="button"
            data-testid={`mobile-model-secondary-group-${subGroup.name.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
            onClick={() => {
              setActiveSubGroupName(subGroup.name)
              setStep('models')
            }}
            className={cn(
              'flex min-h-[44px] w-full items-center justify-between px-4 py-3 text-left',
              'active:bg-[#d1d1d6] dark:active:bg-[#3a3a3c]',
              !isLast && 'border-b border-[#c6c6c8] dark:border-[#38383a]'
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] text-text-primary">{subGroup.name}</div>
              <div className="mt-0.5 text-[13px] text-[#8e8e93]">{subGroup.count}</div>
            </div>
            <ChevronRight className="ml-3 h-5 w-5 flex-shrink-0 text-[#8e8e93]" />
          </button>
        )
      })}
    </div>
  )

  const renderModels = () => (
    <div className="overflow-hidden rounded-xl bg-white dark:bg-[#2c2c2e]">
      {activeSubGroup?.models.map((model, index) =>
        renderModelRow(model, false, index !== activeSubGroup.models.length - 1)
      )}
    </div>
  )

  const renderSearchResults = () => (
    <div className="overflow-hidden rounded-xl bg-white dark:bg-[#2c2c2e]">
      {showDefaultInSearch && renderDefaultRow(searchResults.length > 0)}
      {searchResults.map((model, index) =>
        renderModelRow(model, true, index !== searchResults.length - 1)
      )}
    </div>
  )

  return (
    <Drawer open={isOpen} onOpenChange={setIsOpen}>
      <DrawerTrigger asChild>
        <button
          type="button"
          disabled={isDisabled}
          className={cn(
            'flex w-full items-center min-w-0 max-w-full rounded-full px-3 py-2 h-9',
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
          <span className="flex-1 truncate text-xs min-w-0">{modelSelection.getDisplayText()}</span>
        </button>
      </DrawerTrigger>

      <DrawerContent className="max-h-[85vh] bg-[#f2f2f7] dark:bg-[#1c1c1e]" showHandle={false}>
        {/* iOS-style drag handle */}
        <div className="flex justify-center pt-2 pb-3">
          <div className="w-9 h-1 rounded-full bg-[#3c3c43]/30 dark:bg-[#5c5c5e]" />
        </div>

        {/* Search bar - iOS style */}
        <div className="px-4 pb-3">
          {!isSearching && step !== 'primary' && (
            <button
              type="button"
              data-testid="mobile-model-back-button"
              onClick={() => setStep(step === 'models' ? 'secondary' : 'primary')}
              className="mb-2 flex min-h-[44px] items-center gap-1 text-[#007aff] active:opacity-70"
            >
              <ChevronLeft className="h-5 w-5" />
              <span className="text-[15px]">
                {step === 'models'
                  ? activeGroup?.name
                  : t('common:models.primary_groups', 'Primary groups')}
              </span>
            </button>
          )}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#8e8e93]" />
            <input
              type="text"
              data-testid="mobile-model-search-input"
              placeholder={t('common:models.search_models', 'Search models or groups...')}
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
          ) : modelSelection.isLoading ? (
            <div className="rounded-xl bg-white dark:bg-[#2c2c2e] p-4 text-center text-sm text-[#8e8e93]">
              {t('common:loading', '加载中...')}
            </div>
          ) : isSearching && searchResults.length === 0 && !showDefaultInSearch ? (
            <div className="rounded-xl bg-white dark:bg-[#2c2c2e] p-4 text-center text-sm text-[#8e8e93]">
              {t('common:models.no_match', 'No matching models')}
            </div>
          ) : !isSearching && cascadeGroups.length === 0 && !modelSelection.showDefaultOption ? (
            <div className="rounded-xl bg-white dark:bg-[#2c2c2e] p-4 text-center text-sm text-[#8e8e93]">
              {t('common:models.no_models', '暂无模型')}
            </div>
          ) : isSearching ? (
            renderSearchResults()
          ) : step === 'secondary' ? (
            renderSecondaryGroups()
          ) : step === 'models' ? (
            renderModels()
          ) : (
            renderPrimaryGroups()
          )}
        </div>

        {/* Footer - compact single row */}
        {!isSearchFocused && (
          <div className="px-4 pb-4 pt-2">
            <div className="flex items-center justify-end">
              {/* Settings link */}
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
