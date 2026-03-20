// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * EvaluationModelSelector Component
 *
 * A form-compatible model selector specifically designed for the evaluation module.
 * This component is fully controlled (value/onChange pattern) and works seamlessly
 * with form libraries and React state management.
 *
 * Features:
 * - Fully controlled component (value + onChange)
 * - Supports model selection with optional force_override flag
 * - Displays model list with search/filter capabilities
 * - Shows model provider and display name
 * - Compatible with evaluation module's data structures
 *
 * Usage:
 * ```tsx
 * // Single model selection
 * <EvaluationModelSelector
 *   value={modelId}
 *   onChange={(modelId, forceOverride) => {
 *     setModelId(modelId)
 *     setForceOverride(forceOverride)
 *   }}
 * />
 *
 * // With force override
 * <EvaluationModelSelector
 *   value={modelId}
 *   forceOverride={forceOverride}
 *   onChange={(modelId, forceOverride) => {
 *     setModelId(modelId)
 *     setForceOverride(forceOverride)
 *   }}
 * />
 * ```
 */

'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { ModelIcon } from '@/components/icons/ModelIcon'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { modelApis, UnifiedModel, ModelTypeEnum } from '@/apis/models'

// ============================================================================
// Types
// ============================================================================

/** Model item in the selector */
export interface EvaluationModel {
  /** Unique model identifier (e.g., 'claude-3-5-sonnet', 'gpt-4') */
  name: string
  /** Display name for UI (e.g., 'Claude 3.5 Sonnet') */
  displayName?: string | null
  /** Model provider (e.g., 'anthropic', 'openai') */
  provider: string
  /** Full model ID (e.g., 'claude-3-5-sonnet-20241022') */
  modelId: string
  /** Model type (public, user, group) */
  type?: ModelTypeEnum
  /** Whether this is an advanced model */
  isAdvanced?: boolean
}

/** Props for EvaluationModelSelector */
export interface EvaluationModelSelectorProps {
  /** Selected model ID (controlled) */
  value: string
  /** Callback when selection changes: (modelId, forceOverride) => void */
  onChange: (modelId: string, forceOverride: boolean) => void
  /** Whether to force override bot's default model */
  forceOverride?: boolean
  /** Placeholder text when no model selected */
  placeholder?: string
  /** Whether the selector is disabled */
  disabled?: boolean
  /** Additional CSS classes */
  className?: string
  /** Show force override checkbox */
  showForceOverride?: boolean
  /** Filter to show only specific model types */
  modelTypeFilter?: ModelTypeEnum[]
  /** Whether to show advanced models */
  showAdvanced?: boolean
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Convert UnifiedModel to EvaluationModel */
function unifiedToEvaluationModel(unified: UnifiedModel): EvaluationModel {
  return {
    name: unified.name,
    displayName: unified.displayName,
    provider: unified.provider || '',
    modelId: unified.modelId || unified.name,
    type: unified.type,
    isAdvanced: unified.isAdvanced ?? false,
  }
}

/** Get unique key for model */
function getModelKey(model: EvaluationModel): string {
  return `${model.name}:${model.type || ''}`
}

/** Check if model matches search query */
function matchesSearch(model: EvaluationModel, query: string): boolean {
  if (!query) return true
  const lowerQuery = query.toLowerCase()
  return (
    model.name.toLowerCase().includes(lowerQuery) ||
    (model.displayName?.toLowerCase() || '').includes(lowerQuery) ||
    model.provider.toLowerCase().includes(lowerQuery) ||
    model.modelId.toLowerCase().includes(lowerQuery)
  )
}

// ============================================================================
// Component
// ============================================================================

export function EvaluationModelSelector({
  value,
  onChange,
  forceOverride = false,
  placeholder,
  disabled = false,
  className,
  showForceOverride = true,
  modelTypeFilter,
  showAdvanced = true,
}: EvaluationModelSelectorProps) {
  const { t } = useTranslation('evaluation')
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [models, setModels] = useState<EvaluationModel[]>([])
  const [isLoading, setIsLoading] = useState(false)

  // Fetch models on mount
  useEffect(() => {
    const fetchModels = async () => {
      setIsLoading(true)
      try {
        const response = await modelApis.getUnifiedModels(
          undefined,
          false,
          'all',
          undefined,
          'llm'
        )
        const modelList = (response.data || []).map(unifiedToEvaluationModel)
        setModels(modelList)
      } catch (err) {
        console.error('Failed to fetch models:', err)
      } finally {
        setIsLoading(false)
      }
    }

    fetchModels()
  }, [])

  // Filter models based on criteria
  const filteredModels = useMemo(() => {
    let result = models

    // Filter by model type if specified
    if (modelTypeFilter && modelTypeFilter.length > 0) {
      result = result.filter(m => m.type && modelTypeFilter.includes(m.type))
    }

    // Filter out advanced models unless showAdvanced is true
    if (!showAdvanced) {
      result = result.filter(m => !m.isAdvanced)
    }

    // Filter by search query
    if (searchQuery) {
      result = result.filter(m => matchesSearch(m, searchQuery))
    }

    return result
  }, [models, modelTypeFilter, showAdvanced, searchQuery])

  // Find selected model
  const selectedModel = useMemo(() => {
    if (!value) return null
    return models.find(m => m.name === value) || null
  }, [value, models])

  // Get display text for selected model
  const displayText = useMemo(() => {
    if (!selectedModel) {
      return placeholder || t('grading.select_model') || 'Select Model'
    }
    return selectedModel.displayName || selectedModel.name
  }, [selectedModel, placeholder, t])

  // Handle model selection
  const handleSelect = (modelName: string) => {
    onChange(modelName, forceOverride)
    setIsOpen(false)
    setSearchQuery('')
  }

  // Handle force override change
  const handleForceOverrideChange = (checked: boolean) => {
    onChange(value, checked)
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={isOpen}
            disabled={disabled || isLoading}
            className={cn(
              'w-full justify-between',
              'h-10 px-3',
              'bg-white hover:bg-gray-50',
              'border border-gray-200',
              'text-sm font-normal',
              !value && 'text-text-muted',
              disabled && 'cursor-not-allowed opacity-50'
            )}
          >
            <div className="flex items-center gap-2 min-w-0">
              <ModelIcon className="h-4 w-4 flex-shrink-0 text-text-secondary" />
              <span className="truncate">{displayText}</span>
            </div>
            <ChevronDown className="h-4 w-4 flex-shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[320px] p-0 bg-white border border-gray-200 rounded-lg shadow-lg"
          align="start"
        >
          <div className="flex flex-col max-h-[400px]">
            {/* Search Input */}
            <div className="p-3 border-b border-gray-100">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
                <Input
                  placeholder={t('grading.search_model') || 'Search models...'}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="pl-9 h-9 text-sm"
                />
              </div>
            </div>

            {/* Model List */}
            <div className="flex-1 overflow-y-auto py-1">
              {isLoading ? (
                <div className="py-8 text-center text-sm text-text-muted">
                  {t('common:loading') || 'Loading...'}
                </div>
              ) : filteredModels.length === 0 ? (
                <div className="py-8 text-center text-sm text-text-muted">
                  {searchQuery
                    ? t('grading.no_models_found') || 'No models found'
                    : t('grading.no_models_available') || 'No models available'}
                </div>
              ) : (
                <div className="px-1">
                  {filteredModels.map(model => (
                    <button
                      key={getModelKey(model)}
                      type="button"
                      onClick={() => handleSelect(model.name)}
                      className={cn(
                        'w-full flex items-center gap-3 px-3 py-2.5',
                        'hover:bg-gray-50 transition-colors',
                        'text-left',
                        value === model.name && 'bg-primary/5'
                      )}
                    >
                      <Check
                        className={cn(
                          'h-4 w-4 flex-shrink-0',
                          value === model.name
                            ? 'opacity-100 text-primary'
                            : 'opacity-0'
                        )}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm text-text-primary truncate">
                            {model.displayName || model.name}
                          </span>
                          {model.isAdvanced && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-purple-50 text-purple-600 rounded">
                              {t('grading.advanced') || 'Advanced'}
                            </span>
                          )}
                          {model.type === 'user' && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded">
                              {t('grading.personal') || 'Personal'}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-text-muted truncate">
                          {model.modelId}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Footer with count */}
            <div className="px-3 py-2 border-t border-gray-100 bg-gray-50 rounded-b-lg">
              <span className="text-xs text-text-muted">
                {filteredModels.length} {t('grading.models_available') || 'models available'}
              </span>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* Force Override Checkbox */}
      {showForceOverride && value && (
        <div className="flex items-center gap-2">
          <Checkbox
            id={`force-override-${value}`}
            checked={forceOverride}
            onCheckedChange={handleForceOverrideChange}
            disabled={disabled}
          />
          <Label
            htmlFor={`force-override-${value}`}
            className="text-xs text-text-secondary cursor-pointer"
          >
            {t('grading.force_override') || 'Force override bot default model'}
          </Label>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Multi-Model Selector (for scorer models list)
// ============================================================================

/** Model entry in a multi-model list */
export interface MultiModelEntry {
  id: string
  modelId: string
  forceOverride: boolean
}

/** Props for EvaluationMultiModelSelector */
export interface EvaluationMultiModelSelectorProps {
  /** Array of model entries */
  value: MultiModelEntry[]
  /** Callback when the list changes */
  onChange: (entries: MultiModelEntry[]) => void
  /** Maximum number of models allowed */
  maxModels?: number
  /** Minimum number of models required */
  minModels?: number
  /** Whether the selector is disabled */
  disabled?: boolean
  /** Additional CSS classes */
  className?: string
}

/** Multi-model selector for managing a list of models (e.g., scorer models) */
export function EvaluationMultiModelSelector({
  value,
  onChange,
  maxModels = 10,
  minModels = 0,
  disabled = false,
  className,
}: EvaluationMultiModelSelectorProps) {
  const { t } = useTranslation('evaluation')

  // Add a new model entry
  const addModel = () => {
    if (value.length >= maxModels) return
    const newEntry: MultiModelEntry = {
      id: `model-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      modelId: '',
      forceOverride: true,
    }
    onChange([...value, newEntry])
  }

  // Remove a model entry
  const removeModel = (index: number) => {
    if (value.length <= minModels) return
    const newValue = [...value]
    newValue.splice(index, 1)
    onChange(newValue)
  }

  // Update model at index
  const updateModel = (index: number, modelId: string, forceOverride: boolean) => {
    const newValue = [...value]
    newValue[index] = { ...newValue[index], modelId, forceOverride }
    onChange(newValue)
  }

  return (
    <div className={cn('space-y-3', className)}>
      {/* Model List */}
      {value.map((entry, index) => (
        <div
          key={entry.id}
          className="flex items-start gap-2 p-3 bg-surface rounded-lg border border-border"
        >
          <div className="flex-1 min-w-0 space-y-2">
            <EvaluationModelSelector
              value={entry.modelId}
              onChange={(modelId, force) => updateModel(index, modelId, force)}
              forceOverride={entry.forceOverride}
              disabled={disabled}
              placeholder={t('grading.select_model') || 'Select Model'}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => removeModel(index)}
            disabled={disabled || value.length <= minModels}
            className="mt-0 h-10 w-10 p-0 flex-shrink-0"
          >
            <span className="sr-only">{t('grading.remove_model') || 'Remove'}</span>
            <svg
              className="h-4 w-4 text-red-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </Button>
        </div>
      ))}

      {/* Empty State */}
      {value.length === 0 && (
        <div className="text-center py-6 text-sm text-text-muted bg-surface rounded-lg border border-dashed border-border">
          {t('grading.no_models_configured') || 'No models configured'}
        </div>
      )}

      {/* Add Button */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={addModel}
        disabled={disabled || value.length >= maxModels}
        className="w-full"
      >
        <svg
          className="h-4 w-4 mr-1"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        {t('grading.add_model') || 'Add Model'}
        {maxModels < Infinity && (
          <span className="ml-1 text-xs text-text-muted">
            ({value.length}/{maxModels})
          </span>
        )}
      </Button>
    </div>
  )
}

export default EvaluationModelSelector
